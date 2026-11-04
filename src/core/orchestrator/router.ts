import type { AgentConfig, AgentKind, QuotaProvider, QuotaSnapshot, TaskBrief } from '../../shared/index.ts';
import { minRemainingFraction, quotaSnapshotSchema, redactSecrets } from '../../shared/index.ts';

export const DEFAULT_QUOTA_FLOOR = 0.2;
export const DEFAULT_QUOTA_CACHE_MS = 5 * 60_000;
/** Tras un `quota_exhausted`, tiempo mínimo sin asignar tareas al agente salvo lectura nueva por encima del piso. */
export const DEFAULT_EXHAUSTED_COOLDOWN_MS = 15 * 60_000;

/** Agentes con cupo de suscripción (5 h y semanal): solo reciben tareas por encima de su `quotaFloor`. */
const QUOTA_LIMITED: ReadonlySet<AgentKind> = new Set(['codex-cli', 'agy-cli']);
/** Agentes que trabajan en un worktree (los modelos por API aún no editan código). */
const TOOL_AGENTS: ReadonlySet<AgentKind> = new Set(['claude-sdk', 'codex-cli', 'agy-cli']);

export interface QuotaCheck {
  agentId: string;
  allowed: boolean;
  /** Fracción restante más baja; null si se desconoce. */
  fraction: number | null;
  floor: number;
  warnings: string[];
}

export interface RouteDecision {
  agentId: string;
  reason: string;
  warnings: string[];
}

export class RoutingError extends Error {
  override name = 'RoutingError';
}

/** Lo que el router toma de los ajustes de la interfaz (`Settings` de src/shared/api.ts), sin depender de SQLite. */
export interface RouterSettings {
  /**
   * Subagentes de la flota: solo ellos reciben tareas como autores. Vacío: todos los habilitados. Los ids que el
   * router no conoce (borrados, deshabilitados o sin adaptador) se ignoran; si no queda ninguno, no hay restricción.
   */
  workers: readonly string[];
  /** Piso de cupo de Codex y agy. Con ajustes manda sobre el `quotaFloor` de cada agente. */
  quotaFloor: number;
}

export interface RouterOptions {
  agents: readonly AgentConfig[];
  quotas?: readonly QuotaProvider[];
  /** Piso de cupo si la configuración de un agente no trae `quotaFloor` (20 % por defecto). */
  defaultQuotaFloor?: number;
  /** Validez de una lectura de cupo (5 min por defecto). `invalidateQuota` la descarta antes. */
  quotaCacheMs?: number;
  /** Tareas simultáneas por agente de CLI (Codex, agy): 1 por defecto. Claude no tiene tope. */
  maxParallelPerCli?: number;
  /** Bloqueo tras agotar el cupo (15 min por defecto); una lectura posterior ≥ piso lo levanta antes. */
  exhaustedCooldownMs?: number;
  /** Ajustes vigentes (se leen en cada decisión). `undefined`: sin ajustes (cada agente con su piso, todos asignables). */
  settings?: () => RouterSettings | undefined;
  now?: () => number;
}

type QuotaRead = { snapshot?: QuotaSnapshot; error?: string };

/**
 * Router por dificultad, cupo y carga.
 * - Dificultad `high` → Claude.
 * - Codex/agy solo si `minRemainingFraction(cupo) ≥ quotaFloor`; cupo desconocido → permitido con advertencia.
 * - Pool de instancias de Claude: menos carga primero, empate por turno rotatorio.
 * - El revisor nunca es el autor.
 * - Con ajustes (`settings`): solo los subagentes elegidos (`workers`) son autores y el piso es `quotaFloor`. La
 *   revisión y los rescates (traspaso o reasignación a Claude) prefieren a los elegidos, pero si ninguno sirve usan
 *   cualquier agente habilitado con aviso: una tarea no se queda sin revisor ni a medias por la restricción.
 *
 * Cada decisión (`route`, `chooseReviewer`, `pickClaude`) **arrienda** al agente (carga + 1);
 * quien la recibe debe llamar a `release(agentId)` al terminar (el Supervisor lo hace solo).
 */
export class Router {
  readonly #agents: Map<string, AgentConfig>;
  readonly #order: Map<string, number>;
  readonly #quotas: Map<string, QuotaProvider>;
  readonly #quotaCache = new Map<string, { at: number; promise: Promise<QuotaRead> }>();
  readonly #load = new Map<string, number>();
  readonly #lastAssigned = new Map<string, number>();
  readonly #exhaustedAt = new Map<string, number>();
  readonly #defaultFloor: number;
  readonly #cacheMs: number;
  readonly #maxParallelPerCli: number;
  readonly #exhaustedCooldownMs: number;
  readonly #settings: (() => RouterSettings | undefined) | undefined;
  readonly #now: () => number;
  #tick = 0;

  constructor(opts: RouterOptions) {
    this.#agents = new Map(opts.agents.map((a) => [a.id, a]));
    this.#order = new Map(opts.agents.map((a, i) => [a.id, i]));
    this.#quotas = new Map((opts.quotas ?? []).map((q) => [q.agentId, q]));
    this.#defaultFloor = opts.defaultQuotaFloor ?? DEFAULT_QUOTA_FLOOR;
    this.#cacheMs = opts.quotaCacheMs ?? DEFAULT_QUOTA_CACHE_MS;
    this.#maxParallelPerCli = opts.maxParallelPerCli ?? 1;
    this.#exhaustedCooldownMs = opts.exhaustedCooldownMs ?? DEFAULT_EXHAUSTED_COOLDOWN_MS;
    this.#settings = opts.settings;
    this.#now = opts.now ?? Date.now;
  }

  agent(agentId: string): AgentConfig | undefined {
    return this.#agents.get(agentId);
  }

  isClaude(agentId: string): boolean {
    return this.#agents.get(agentId)?.kind === 'claude-sdk';
  }

  load(agentId: string): number {
    return this.#load.get(agentId) ?? 0;
  }

  /** Arrienda un agente concreto (p. ej. para devolver la tarea a su autor). */
  acquire(agentId: string): void {
    if (!this.#agents.has(agentId)) throw new RoutingError(`Agente desconocido: ${agentId}.`);
    this.#load.set(agentId, this.load(agentId) + 1);
    this.#lastAssigned.set(agentId, ++this.#tick);
  }

  release(agentId: string): void {
    const n = this.load(agentId);
    if (n <= 1) this.#load.delete(agentId);
    else this.#load.set(agentId, n - 1);
  }

  /** Olvida la lectura de cupo (todas si no se indica agente): la próxima decisión vuelve a leer. */
  invalidateQuota(agentId?: string): void {
    if (agentId) this.#quotaCache.delete(agentId);
    else this.#quotaCache.clear();
  }

  /**
   * El agente informó `quota_exhausted`: descarta su lectura de cupo y no se le asignan tareas hasta que pase
   * `exhaustedCooldownMs` o una lectura tomada después muestre cupo ≥ piso.
   */
  markExhausted(agentId: string): void {
    this.#exhaustedAt.set(agentId, this.#now());
    this.invalidateQuota(agentId);
  }

  /** Elige al autor de una tarea. */
  async route(task: TaskBrief, opts: { exclude?: readonly string[] } = {}): Promise<RouteDecision> {
    const exclude = new Set(opts.exclude ?? []);
    const warnings: string[] = [];
    const suggested = task.suggestedAgent;

    if (task.difficulty === 'high') {
      if (suggested && this.#usable(suggested, exclude) && this.isClaude(suggested)) return this.#assign(suggested, 'dificultad alta → Claude sugerido', warnings);
      if (suggested && !this.isClaude(suggested)) warnings.push(`Se ignora el agente sugerido ${suggested}: la dificultad alta va a Claude.`);
      return this.#assign(this.#claudeOrder(exclude)[0], 'dificultad alta → Claude', warnings);
    }

    if (suggested) {
      if (!this.#usable(suggested, exclude)) {
        warnings.push(
          this.#usable(suggested, exclude, false)
            ? `El agente sugerido ${suggested} no está entre los subagentes elegidos en Ajustes.`
            : `El agente sugerido ${suggested} no está disponible.`,
        );
      } else if (this.isClaude(suggested)) {
        return this.#assign(suggested, 'agente sugerido', warnings);
      } else {
        const check = await this.checkQuota(suggested);
        if (check.allowed && this.load(suggested) < this.#maxParallelPerCli) {
          return this.#assign(suggested, `agente sugerido; ${describe(check)}`, [...warnings, ...check.warnings]);
        }
        warnings.push(check.allowed ? `El agente sugerido ${suggested} está ocupado.` : `El agente sugerido ${suggested} no tiene cupo: ${describe(check)}.`);
      }
    }

    const checks = await this.#allowedCli(exclude, warnings);
    // Desde aquí, síncrono hasta `#assign`: la capacidad se comprueba y se reserva en el mismo paso, así dos
    // decisiones simultáneas no pueden quedarse con el mismo hueco de un CLI.
    const best = this.#rankCli(checks)[0];
    if (best) return this.#assign(best.agentId, describe(best), [...warnings, ...best.warnings]);
    const claude = this.#claudeOrder(exclude, false)[0];
    if (claude) return this.#assign(claude, 'sin Codex/agy con cupo libre → Claude', warnings);
    if (this.#workers()) {
      // Subagentes elegidos sin Claude y todos ocupados: antes que fallar la tarea, el elegido con cupo y menos carga.
      const busy = this.#rankCli(checks, true)[0];
      if (busy) {
        return this.#assign(busy.agentId, `${describe(busy)}; único subagente elegido con cupo`, [
          ...warnings,
          ...busy.warnings,
          `${busy.agentId} recibe la tarea aunque ya tiene ${this.load(busy.agentId)} en curso: es el único subagente elegido en Ajustes con cupo.`,
        ]);
      }
    }
    return this.#assign(this.#claudeOrder(exclude)[0], 'sin Codex/agy con cupo libre → Claude', warnings);
  }

  /**
   * Claude con menos carga (para traspasos y reasignaciones). Prefiere los subagentes elegidos; si ningún Claude lo es,
   * continúa cualquier Claude habilitado (con aviso): el rescate no deja la tarea a medias.
   */
  pickClaude(opts: { exclude?: readonly string[] } = {}): RouteDecision {
    const exclude = new Set(opts.exclude ?? []);
    const preferred = this.#claudeOrder(exclude, false)[0];
    if (preferred) return this.#assign(preferred, 'Claude con menos carga', []);
    const any = this.#workers() ? this.#claudeOrder(exclude, false, false)[0] : undefined;
    if (any) return this.#assign(any, 'Claude con menos carga', [`Ningún Claude está entre los subagentes elegidos en Ajustes: continúa ${any}.`]);
    return this.#assign(this.#claudeOrder(exclude)[0], 'Claude con menos carga', []);
  }

  /**
   * Revisor de una tarea: nunca uno de sus autores. Si el autor es Claude se prefiere Codex/agy con cupo
   * (revisión cruzada que ahorra presupuesto de Claude); si no, Claude.
   */
  async chooseReviewer(task: TaskBrief, author: string | readonly string[]): Promise<RouteDecision> {
    const authors = typeof author === 'string' ? [author] : [...author];
    const exclude = new Set(authors);
    const warnings: string[] = [];
    const restricted = this.#workers() !== undefined;
    const checks = await this.#allowedCli(exclude, warnings);
    const fallbackWarnings: string[] = [];
    const allChecks = restricted ? await this.#allowedCli(exclude, fallbackWarnings, false) : checks;
    // Síncrono desde aquí hasta `#assign` (ver `route`).
    let chosen = this.#reviewerFor(authors, exclude, checks, true);
    if (!chosen && restricted) {
      chosen = this.#reviewerFor(authors, exclude, allChecks, false);
      if (chosen) {
        warnings.push(...fallbackWarnings.filter((w) => !warnings.includes(w)));
        chosen.warnings.push(`Ningún subagente elegido en Ajustes puede revisar ${task.id}: revisa ${chosen.id}.`);
      }
    }
    if (!chosen) throw new RoutingError(`No hay revisor disponible para ${task.id} distinto de ${authors.join(', ')}.`);
    return this.#assign(chosen.id, `revisión cruzada (autor: ${authors.join(' → ')})`, [...warnings, ...chosen.warnings]);
  }

  /** Síncrono: el revisor según la regla de revisión cruzada, o `undefined`. */
  #reviewerFor(authors: readonly string[], exclude: ReadonlySet<string>, checks: readonly QuotaCheck[], onlyWorkers: boolean): { id: string; warnings: string[] } | undefined {
    const claudes = this.#claudeOrder(exclude, false, onlyWorkers);
    const cli = this.#rankCli(checks);
    const lastAuthor = authors.at(-1);
    const authorIsClaude = lastAuthor !== undefined && this.isClaude(lastAuthor);
    const candidates = authorIsClaude
      ? [...cli.map((c) => ({ id: c.agentId, warnings: [...c.warnings] })), ...claudes.map((id) => ({ id, warnings: [] as string[] }))]
      : [...claudes.map((id) => ({ id, warnings: [] as string[] })), ...cli.map((c) => ({ id: c.agentId, warnings: [...c.warnings] }))];
    const chosen = candidates.find((c) => !exclude.has(c.id));
    if (chosen) return chosen;
    // Antes que dejar la tarea sin revisión, un CLI con cupo revisa aunque ya esté ocupado.
    const busy = this.#rankCli(checks, true)[0];
    return busy && { id: busy.agentId, warnings: [...busy.warnings, `${busy.agentId} revisa aunque ya tiene ${this.load(busy.agentId)} tarea(s) en curso.`] };
  }

  /** Lee (o reutiliza) el cupo y lo compara con el piso del agente. */
  async checkQuota(agentId: string): Promise<QuotaCheck> {
    const floor = this.#settings?.()?.quotaFloor ?? this.#agents.get(agentId)?.quotaFloor ?? this.#defaultFloor;
    const provider = this.#quotas.get(agentId);
    const exhaustedAt = this.#exhaustedAt.get(agentId);
    const cooling = exhaustedAt !== undefined && this.#now() - exhaustedAt < this.#exhaustedCooldownMs;
    if (exhaustedAt !== undefined && !cooling) this.#exhaustedAt.delete(agentId);
    if (!provider) {
      if (cooling) return { agentId, allowed: false, fraction: 0, floor, warnings: [`${agentId}: agotó el cupo hace poco.`] };
      return { agentId, allowed: true, fraction: null, floor, warnings: [`${agentId}: sin proveedor de cupo; se permite con advertencia.`] };
    }
    const read = await this.#readQuota(provider);
    const warnings: string[] = [];
    const fraction = read.snapshot ? minRemainingFraction(read.snapshot) : null;
    if (read.error) warnings.push(`${agentId}: no se pudo leer el cupo (${read.error}); se permite con advertencia.`);
    else if (fraction === null) warnings.push(`${agentId}: cupo desconocido; se permite con advertencia.`);
    if (read.snapshot?.error) warnings.push(`${agentId}: aviso del proveedor de cupo: ${redactSecrets(read.snapshot.error)}.`);
    if (read.snapshot?.stale) warnings.push(`${agentId}: lectura de cupo antigua.`);
    if (cooling) {
      // Solo una lectura tomada después del agotamiento y por encima del piso levanta el bloqueo antes de tiempo.
      const takenAt = read.snapshot ? Date.parse(read.snapshot.takenAt) : Number.NaN;
      const recovered = read.snapshot !== undefined && !read.snapshot.stale && takenAt >= exhaustedAt && fraction !== null && fraction >= floor;
      if (!recovered) return { agentId, allowed: false, fraction: fraction ?? 0, floor, warnings: [...warnings, `${agentId}: agotó el cupo hace poco.`] };
      this.#exhaustedAt.delete(agentId);
    }
    return { agentId, allowed: fraction === null || fraction >= floor, fraction, floor, warnings };
  }

  /** `onlyWorkers`: además, que esté entre los subagentes elegidos en los ajustes (si los hay). */
  #usable(agentId: string, exclude: ReadonlySet<string>, onlyWorkers = true): boolean {
    const a = this.#agents.get(agentId);
    if (a === undefined || a.enabled === false || !TOOL_AGENTS.has(a.kind) || exclude.has(agentId)) return false;
    const workers = onlyWorkers ? this.#workers() : undefined;
    return workers === undefined || workers.has(agentId);
  }

  /** Subagentes elegidos que el router conoce, o `undefined` si no hay restricción. */
  #workers(): ReadonlySet<string> | undefined {
    const known = (this.#settings?.()?.workers ?? []).filter((id) => this.#agents.has(id));
    return known.length > 0 ? new Set(known) : undefined;
  }

  /** Instancias de Claude ordenadas por carga y turno. Lanza si no hay ninguna (salvo `required = false`). */
  #claudeOrder(exclude: ReadonlySet<string>, required = true, onlyWorkers = true): string[] {
    const ids = [...this.#agents.values()]
      .filter((a) => a.kind === 'claude-sdk' && this.#usable(a.id, exclude, onlyWorkers))
      .map((a) => a.id)
      .sort((x, y) => this.#compareLoad(x, y));
    if (required && ids.length === 0) {
      const excluded = exclude.size ? ` (excluidos: ${[...exclude].join(', ')})` : '';
      const workers = onlyWorkers ? this.#workers() : undefined;
      const among = workers ? ` entre los subagentes elegidos en Ajustes (${[...workers].join(', ')})` : '';
      throw new RoutingError(`No hay instancias de Claude disponibles${among}${excluded}.`);
    }
    return ids;
  }

  /** Codex/agy usables con cupo ≥ piso (lectura asíncrona; la carga se mira después, en `#rankCli`). */
  async #allowedCli(exclude: ReadonlySet<string>, warnings: string[], onlyWorkers = true): Promise<QuotaCheck[]> {
    const ids = [...this.#agents.values()].filter((a) => QUOTA_LIMITED.has(a.kind) && this.#usable(a.id, exclude, onlyWorkers)).map((a) => a.id);
    const checks = await Promise.all(ids.map((id) => this.checkQuota(id)));
    const allowed: QuotaCheck[] = [];
    for (const check of checks) {
      if (!check.allowed) warnings.push(`${check.agentId} descartado: ${describe(check)}.`);
      else allowed.push(check);
    }
    return allowed;
  }

  /**
   * Síncrono: candidatos con hueco libre ahora mismo (sin `ignoreLoad`, solo los que no llegaron a
   * `maxParallelPerCli`), por carga, cupo restante y turno. Debe usarse en el mismo paso que `#assign`.
   */
  #rankCli(checks: readonly QuotaCheck[], ignoreLoad = false): QuotaCheck[] {
    const eligible = checks.filter((c) => ignoreLoad || this.load(c.agentId) < this.#maxParallelPerCli);
    return eligible.sort((a, b) => {
      const byLoad = this.load(a.agentId) - this.load(b.agentId);
      if (byLoad !== 0) return byLoad;
      if (a.fraction !== b.fraction) return (b.fraction ?? -1) - (a.fraction ?? -1);
      return this.#compareLoad(a.agentId, b.agentId);
    });
  }

  #compareLoad(x: string, y: string): number {
    return (
      this.load(x) - this.load(y) ||
      (this.#lastAssigned.get(x) ?? 0) - (this.#lastAssigned.get(y) ?? 0) ||
      (this.#order.get(x) ?? 0) - (this.#order.get(y) ?? 0)
    );
  }

  #assign(agentId: string | undefined, reason: string, warnings: string[]): RouteDecision {
    if (!agentId) throw new RoutingError('No hay agentes disponibles.');
    this.acquire(agentId);
    return { agentId, reason, warnings };
  }

  #readQuota(provider: QuotaProvider): Promise<QuotaRead> {
    const now = this.#now();
    const cached = this.#quotaCache.get(provider.agentId);
    if (cached && now - cached.at < this.#cacheMs) return cached.promise;
    const promise = provider.read().then(
      (raw): QuotaRead => {
        const parsed = quotaSnapshotSchema.safeParse(raw);
        return parsed.success ? { snapshot: parsed.data } : { error: 'lectura de cupo con formato inválido' };
      },
      (err: unknown): QuotaRead => ({ error: redactSecrets(err instanceof Error ? err.message : String(err)) }),
    );
    this.#quotaCache.set(provider.agentId, { at: now, promise });
    return promise;
  }
}

function describe(check: QuotaCheck): string {
  const floor = `${Math.round(check.floor * 100)} %`;
  if (check.fraction === null) return `cupo desconocido (piso ${floor})`;
  const pct = `${Math.round(check.fraction * 1000) / 10} %`;
  return check.allowed ? `cupo ${pct} ≥ piso ${floor}` : `cupo ${pct} < piso ${floor}`;
}
