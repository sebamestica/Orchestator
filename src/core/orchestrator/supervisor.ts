import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent, ErrorCode, EventSink, Handoff, RunContext, TaskBrief } from '../../shared/index.ts';
import { agentEventSchema, handoffSchema, redactSecrets } from '../../shared/index.ts';
import type { TaskQueue } from './queue.ts';
import { RoutingError, type Router } from './router.ts';

export const DEFAULT_TIMEOUT_MS = 60 * 60_000;
/** Tras cancelar o vencer el plazo, tiempo que se espera a que el adaptador cierre por su cuenta. */
export const DEFAULT_GRACE_MS = 5_000;
/** Intentos de ejecución por tarea (incluye traspasos y reasignaciones). */
export const DEFAULT_MAX_ATTEMPTS = 4;
/** Fallos seguidos del mismo agente antes de reasignar a Claude (regla del plan, §4.4). */
export const FAILURES_BEFORE_REASSIGN = 2;
export const HANDOFF_FILE = join('.orq', 'HANDOFF.md');

const TEXT_TAIL = 8;
const DEFAULT_SUMMARY_CHARS = 6_000;

export type AttemptOutcome = 'ok' | 'failed' | 'quota_exhausted' | 'timeout' | 'cancelled';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** Resultado de una ejecución de un adaptador. Todo el texto ya está tachado con `redactSecrets`. */
export interface AttemptResult {
  agentId: string;
  sessionId: string;
  outcome: AttemptOutcome;
  ok: boolean;
  error?: { code: ErrorCode; message: string };
  /** `done.summary` del adaptador. */
  summary?: string;
  /** Últimos textos del asistente (los más recientes al final). */
  texts: string[];
  filesChanged: string[];
  usage: UsageTotals;
  events: number;
  startedAt: string;
  endedAt: string;
}

export interface AttemptOptions {
  worktreePath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  handoff?: Handoff;
  /** Número de intento (para identificar la sesión sintética si el adaptador no emitió ninguna). */
  attempt?: number;
}

export interface BeforeAttemptInfo {
  task: TaskBrief;
  agentId: string;
  worktreePath: string;
  attempt: number;
  handoff?: Handoff;
}

export interface ExecuteOptions {
  /** Agente inicial. El Supervisor toma su arriendo del Router y lo libera al terminar. */
  agentId: string;
  worktreePath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Traspaso con el que empieza (p. ej. reasignación tras fallos de integración). */
  handoff?: Handoff;
  /** Agentes que no pueden recibir la tarea en un traspaso (p. ej. los autores, si es una revisión). */
  exclude?: readonly string[];
  maxAttempts?: number;
  /** Reflejar los traspasos en la cola (por defecto, sí). Falso para ejecuciones que no son la tarea encolada (revisiones). */
  updateQueue?: boolean;
  /** Se llama antes de cada intento (p. ej. para reescribir `.orq/BRIEF.md` con el traspaso). */
  beforeAttempt?: (info: BeforeAttemptInfo) => void | Promise<void>;
}

export interface ExecuteResult {
  ok: boolean;
  outcome: 'ok' | 'failed' | 'cancelled';
  /** Agente del último intento. */
  agentId: string;
  /** Agentes que trabajaron en la tarea, en orden y sin repetir. */
  authors: string[];
  attempts: AttemptResult[];
  handoffs: Handoff[];
  /** Fallos seguidos del último agente al terminar. */
  failureStreak: number;
  error?: string;
}

export interface SupervisorOptions {
  adapters: Iterable<AgentAdapter>;
  router: Router;
  sink: EventSink;
  /** Si se indica, los traspasos se reflejan en la cola (`running → handed_off → running`). */
  queue?: TaskQueue;
  /** Variables (claves incluidas) para el proceso de cada agente; sus valores se tachan de todos los eventos. */
  env?: (agentId: string) => Readonly<Record<string, string>>;
  /** Lee un archivo del worktree; `undefined` si no existe. Por defecto, `fs.readFile` en UTF-8. */
  readFile?: (path: string) => Promise<string | undefined>;
  onHandoff?: (handoff: Handoff) => void | Promise<void>;
  timeoutMs?: number;
  graceMs?: number;
  maxAttempts?: number;
  summaryChars?: number;
  now?: () => number;
}

/**
 * Ejecuta adaptadores bajo supervisión: reenvía cada evento (validado y tachado) al `EventSink`, aplica plazo y
 * cancelación y decide qué pasa si algo falla:
 * - `quota_exhausted` → traspaso a un Claude **en el mismo worktree** con el resumen de lo hecho y `.orq/HANDOFF.md`;
 * - un fallo → reintento con el mismo agente; dos fallos seguidos → reasignación a Claude (otra instancia si el
 *   que falló ya era Claude y hay más).
 */
export class Supervisor {
  readonly #adapters = new Map<string, AgentAdapter>();
  readonly #router: Router;
  readonly #sink: EventSink;
  readonly #queue: TaskQueue | undefined;
  readonly #env: (agentId: string) => Readonly<Record<string, string>>;
  readonly #readFile: (path: string) => Promise<string | undefined>;
  readonly #onHandoff: ((handoff: Handoff) => void | Promise<void>) | undefined;
  readonly #timeoutMs: number;
  readonly #graceMs: number;
  readonly #maxAttempts: number;
  readonly #summaryChars: number;
  readonly #now: () => number;

  constructor(opts: SupervisorOptions) {
    for (const adapter of opts.adapters) this.#adapters.set(adapter.config.id, adapter);
    this.#router = opts.router;
    this.#sink = opts.sink;
    this.#queue = opts.queue;
    this.#env = opts.env ?? (() => ({}));
    this.#readFile = opts.readFile ?? readUtf8IfExists;
    this.#onHandoff = opts.onHandoff;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.#maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#summaryChars = opts.summaryChars ?? DEFAULT_SUMMARY_CHARS;
    this.#now = opts.now ?? Date.now;
  }

  hasAdapter(agentId: string): boolean {
    return this.#adapters.has(agentId);
  }

  /** Ejecuta la tarea con la política de traspasos y reintentos. Nunca lanza: los errores van en el resultado. */
  async execute(task: TaskBrief, opts: ExecuteOptions): Promise<ExecuteResult> {
    const maxAttempts = opts.maxAttempts ?? this.#maxAttempts;
    const exclude = opts.exclude ?? [];
    const attempts: AttemptResult[] = [];
    const handoffs: Handoff[] = [];
    const authors = [opts.agentId];
    let agentId = opts.agentId;
    let handoff = opts.handoff;
    let failures = 0;
    const result = (outcome: ExecuteResult['outcome'], error?: string): ExecuteResult => {
      const out: ExecuteResult = { ok: outcome === 'ok', outcome, agentId, authors, attempts, handoffs, failureStreak: failures };
      if (error) out.error = redactSecrets(error);
      return out;
    };

    try {
      for (let n = 1; n <= maxAttempts; n++) {
        if (opts.signal?.aborted) return result('cancelled', 'cancelada');
        await opts.beforeAttempt?.({ task, agentId, worktreePath: opts.worktreePath, attempt: n, handoff });
        const attempt = await this.runAttempt(task, agentId, { worktreePath: opts.worktreePath, signal: opts.signal, timeoutMs: opts.timeoutMs, handoff, attempt: n });
        attempts.push(attempt);
        if (attempt.ok) return result('ok');
        if (attempt.outcome === 'cancelled') return result('cancelled', attempt.error?.message ?? 'cancelada');
        // El agotamiento se registra siempre, también en el último intento: el bloqueo del agente no depende
        // de que quede un intento para traspasar.
        if (attempt.outcome === 'quota_exhausted') this.#router.markExhausted(agentId);
        if (n === maxAttempts) break;

        let to: string;
        let reason: Handoff['reason'];
        if (attempt.outcome === 'quota_exhausted') {
          // Regla del usuario: si un agente agota el cupo, Claude continúa en el mismo worktree.
          to = this.#takeClaude(exclude, agentId, false);
          reason = 'quota_exhausted';
          failures = 0;
        } else {
          failures++;
          reason = attempt.outcome === 'timeout' ? 'timeout' : 'failure';
          if (failures >= FAILURES_BEFORE_REASSIGN) {
            to = this.#takeClaude(exclude, agentId, true);
            failures = 0;
          } else {
            to = agentId; // un fallo: vuelve al mismo agente con el resumen de lo que pasó
          }
        }

        const from = agentId;
        if (to !== from) {
          // El arriendo pasa al nuevo agente antes de cualquier otra cosa: `finally` libera siempre el actual.
          this.#router.release(from);
          agentId = to;
          if (!authors.includes(to)) authors.push(to);
        }
        handoff = await this.buildHandoff(task, attempt, { toAgent: to, reason, worktreePath: opts.worktreePath });
        if (to !== from) {
          handoffs.push(handoff);
          if (opts.updateQueue !== false) this.#moveQueue(task.id, from, to, reason);
          await this.#notifyHandoff(handoff);
        }
      }
      return result('failed', `${task.id}: sin éxito tras ${attempts.length} intentos (último: ${describeAttempt(attempts.at(-1))}).`);
    } catch (err) {
      return result('failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.#router.release(agentId);
    }
  }

  /** Una ejecución de un adaptador: eventos al sink, plazo, cancelación y clasificación del resultado. */
  async runAttempt(task: TaskBrief, agentId: string, opts: AttemptOptions): Promise<AttemptResult> {
    const adapter = this.#adapters.get(agentId);
    const env = this.#env(agentId);
    const secrets = Object.values(env);
    const state = new AttemptState(agentId, `${task.id}-${agentId}-${opts.attempt ?? 1}`, this.#iso());
    if (!adapter) {
      state.fail('crash', `No hay adaptador para el agente ${agentId}.`);
      return state.finish(this.#iso());
    }

    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    let abortReason: 'timeout' | 'cancelled' | undefined;
    const abort = (why: 'timeout' | 'cancelled') => {
      abortReason ??= why;
      controller.abort();
    };
    const onExternalAbort = () => abort('cancelled');
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (opts.signal?.aborted) abort('cancelled');
    const timer = setTimeout(() => abort('timeout'), timeoutMs);
    const aborted = new Promise<'abort'>((resolve) => {
      if (controller.signal.aborted) resolve('abort');
      else controller.signal.addEventListener('abort', () => resolve('abort'), { once: true });
    });
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let grace: Promise<'grace'> | undefined;

    const ctx: RunContext = { worktreePath: opts.worktreePath, env, signal: controller.signal, timeoutMs };
    if (opts.handoff) ctx.handoff = opts.handoff;

    let iterator: AsyncIterator<AgentEvent> | undefined;
    let abandoned = false;
    try {
      iterator = adapter.run(task, ctx)[Symbol.asyncIterator]();
      let pending: Promise<IteratorResult<AgentEvent>> | undefined;
      while (true) {
        if (!pending) {
          pending = iterator.next();
          pending.catch(() => undefined); // si se abandona, que su rechazo no quede sin manejar
        }
        const winner = await Promise.race<IteratorResult<AgentEvent> | 'abort' | 'grace'>([pending, grace ?? aborted]);
        if (winner === 'abort') {
          // Se da un margen para que el adaptador cierre (mata el proceso, emite error y done).
          grace = new Promise((resolve) => { graceTimer = setTimeout(() => resolve('grace'), this.#graceMs); });
          continue;
        }
        if (winner === 'grace') {
          abandoned = true;
          break;
        }
        pending = undefined;
        if (winner.done) break;
        this.#forward(winner.value, state, secrets);
        if (state.done) break;
      }
    } catch (err) {
      state.fail('crash', `El adaptador ${agentId} falló: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
      if (iterator?.return) {
        let closing: Promise<unknown>;
        try {
          closing = Promise.resolve(iterator.return()).catch(() => undefined);
        } catch {
          closing = Promise.resolve();
        }
        // Con un `next()` colgado, `return()` no termina nunca: no se espera. Si no, se espera como mucho
        // `graceMs`: un cierre colgado no puede retener la tarea ni el arriendo.
        if (!abandoned) await withDeadline(closing, this.#graceMs);
      }
    }

    if (abortReason) {
      const message = abortReason === 'timeout' ? `Plazo de ${timeoutMs} ms vencido.` : 'Ejecución cancelada.';
      state.abort(abortReason, message);
    } else if (!state.done && !state.error) {
      state.fail('crash', `El adaptador ${agentId} terminó sin evento done.`);
    }
    // Cierra la sesión en el sink si el adaptador no lo hizo.
    if (!state.done) {
      const error = state.error;
      if (error && !state.errorEmitted) this.#emitSynthetic(state, { type: 'error', payload: { code: error.code, message: error.message } }, secrets);
      this.#emitSynthetic(state, { type: 'done', payload: error ? { ok: false, summary: error.message } : { ok: false } }, secrets);
    }
    return state.finish(this.#iso());
  }

  /** Construye (y valida) el traspaso: errores, archivos tocados, últimos textos y `.orq/HANDOFF.md` si existe. */
  async buildHandoff(
    task: TaskBrief,
    attempt: AttemptResult,
    to: { toAgent: string; reason: Handoff['reason']; worktreePath: string; note?: string },
  ): Promise<Handoff> {
    let handoffFile: string | undefined;
    try {
      handoffFile = await this.#readFile(join(to.worktreePath, HANDOFF_FILE));
    } catch {
      handoffFile = undefined;
    }
    const partialSummary = summarizeAttempt(attempt, { note: to.note, handoffFile, maxChars: this.#summaryChars });
    return handoffSchema.parse({
      taskId: task.id,
      fromAgent: attempt.agentId,
      toAgent: to.toAgent,
      reason: to.reason,
      worktreePath: to.worktreePath,
      partialSummary: redactSecrets(partialSummary, Object.values(this.#env(attempt.agentId))),
      at: this.#iso(),
    });
  }

  /** Claude que recibe la tarea. `retryCurrent`: si el actual ya es Claude y no hay otro, sigue él. */
  #takeClaude(exclude: readonly string[], current: string, retryCurrent: boolean): string {
    const currentIsClaude = this.#router.isClaude(current);
    try {
      return this.#router.pickClaude({ exclude: currentIsClaude ? [...exclude, current] : exclude }).agentId;
    } catch (err) {
      if (err instanceof RoutingError && retryCurrent && currentIsClaude) return current; // no hay otro Claude: sigue el mismo
      throw err;
    }
  }

  #moveQueue(taskId: string, from: string, to: string, reason: Handoff['reason']): void {
    const queue = this.#queue;
    const entry = queue?.get(taskId);
    if (!queue || !entry) return;
    if (entry.state !== 'running') {
      queue.assign(taskId, to);
      return;
    }
    queue.transition(taskId, 'handed_off', { agentId: from, detail: `${reason}: ${from} → ${to}` });
    queue.transition(taskId, 'running', { agentId: to, detail: `continúa ${to} en el mismo worktree` });
  }

  async #notifyHandoff(handoff: Handoff): Promise<void> {
    try {
      await this.#onHandoff?.(handoff);
    } catch (err) {
      console.error(`Error al notificar un traspaso: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #forward(raw: AgentEvent, state: AttemptState, secrets: readonly string[]): void {
    const parsed = agentEventSchema.safeParse(redactDeep(raw, secrets));
    if (!parsed.success) {
      // Un evento mal formado se muestra como texto en lugar de romper la sesión.
      const line = redactSecrets(safeStringify(raw), secrets).slice(0, 2_000);
      this.#emitSynthetic(state, { type: 'raw', payload: { source: 'supervisor:evento-invalido', line } }, secrets);
      return;
    }
    state.observe(parsed.data);
    this.#append(parsed.data);
  }

  #emitSynthetic(state: AttemptState, body: SyntheticBody, secrets: readonly string[]): void {
    const event = agentEventSchema.parse(redactDeep(state.synthetic(body, this.#iso()), secrets));
    state.observe(event);
    this.#append(event);
  }

  #append(event: AgentEvent): void {
    try {
      this.#sink.append(event);
    } catch (err) {
      console.error(`Error al guardar un evento: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}

type SyntheticBody =
  | { type: 'error'; payload: { code: ErrorCode; message: string } }
  | { type: 'done'; payload: { ok: boolean; summary?: string } }
  | { type: 'raw'; payload: { source: string; line: string } };

/** Acumula lo que se sabe de una ejecución mientras llegan los eventos. */
class AttemptState {
  readonly agentId: string;
  sessionId: string;
  readonly startedAt: string;
  seq = -1;
  events = 0;
  done: { ok: boolean; summary?: string } | undefined;
  error: { code: ErrorCode; message: string } | undefined;
  errorEmitted = false;
  quota = false;
  outcome: AttemptOutcome | undefined;
  readonly texts: string[] = [];
  readonly files = new Set<string>();
  readonly usage: UsageTotals = { inputTokens: 0, outputTokens: 0 };
  #sawSession = false;

  constructor(agentId: string, fallbackSessionId: string, startedAt: string) {
    this.agentId = agentId;
    this.sessionId = fallbackSessionId;
    this.startedAt = startedAt;
  }

  observe(event: AgentEvent): void {
    this.events++;
    if (!this.#sawSession) {
      this.sessionId = event.sessionId;
      this.#sawSession = true;
    }
    this.seq = Math.max(this.seq, event.seq);
    switch (event.type) {
      case 'text':
        if (event.payload.role === 'assistant' && event.payload.text.trim()) {
          this.texts.push(event.payload.text);
          if (this.texts.length > TEXT_TAIL) this.texts.shift();
        }
        break;
      case 'file_change':
        this.files.add(event.payload.path);
        break;
      case 'usage':
        this.usage.inputTokens += event.payload.inputTokens;
        this.usage.outputTokens += event.payload.outputTokens;
        if (event.payload.costUsd !== undefined) this.usage.costUsd = (this.usage.costUsd ?? 0) + event.payload.costUsd;
        break;
      case 'error':
        this.errorEmitted = true;
        if (event.payload.code === 'quota_exhausted') this.quota = true;
        // El primer error de cupo manda; si no, el último error.
        if (!this.error || this.error.code !== 'quota_exhausted') this.error = { ...event.payload };
        break;
      case 'done':
        this.done = { ...event.payload };
        break;
      default:
        break;
    }
  }

  fail(code: ErrorCode, message: string): void {
    this.error ??= { code, message };
  }

  abort(reason: 'timeout' | 'cancelled', message: string): void {
    this.outcome = reason;
    if (this.error?.code !== reason) this.errorEmitted = false;
    this.error = { code: reason, message };
  }

  synthetic(body: SyntheticBody, ts: string): AgentEvent {
    return { ...body, sessionId: this.sessionId, agentId: this.agentId, seq: this.seq + 1, ts } as AgentEvent;
  }

  finish(endedAt: string): AttemptResult {
    const ok = this.outcome === undefined && this.done?.ok === true && !this.quota;
    const outcome: AttemptOutcome = this.outcome ?? (ok ? 'ok' : this.quota ? 'quota_exhausted' : this.error?.code === 'timeout' ? 'timeout' : 'failed');
    const result: AttemptResult = {
      agentId: this.agentId,
      sessionId: this.sessionId,
      outcome,
      ok,
      texts: [...this.texts],
      filesChanged: [...this.files],
      usage: { ...this.usage },
      events: this.events,
      startedAt: this.startedAt,
      endedAt,
    };
    if (!ok) result.error = this.error ?? { code: 'unknown', message: 'El agente terminó con done.ok = false.' };
    if (this.done?.summary) result.summary = this.done.summary;
    return result;
  }
}

/** Resumen de una ejecución para el siguiente agente. */
export function summarizeAttempt(
  attempt: AttemptResult,
  opts: { note?: string; handoffFile?: string; maxChars?: number } = {},
): string {
  const max = opts.maxChars ?? DEFAULT_SUMMARY_CHARS;
  const parts: string[] = [];
  if (opts.note?.trim()) parts.push(opts.note.trim());
  parts.push(`Intento de ${attempt.agentId}: ${describeAttempt(attempt)}.`);
  if (attempt.filesChanged.length) parts.push(`Archivos tocados: ${attempt.filesChanged.join(', ')}.`);
  if (attempt.summary) parts.push(`Resumen del agente: ${attempt.summary}`);
  const fileBudget = opts.handoffFile?.trim() ? Math.floor(max / 2) : 0;
  const texts = attempt.texts.map((t) => t.trim()).filter(Boolean);
  if (texts.length) {
    const budget = Math.max(200, max - fileBudget - parts.join('\n').length - 60);
    parts.push('Últimos mensajes del agente:', tail(texts.map((t) => `> ${t.replace(/\n/g, '\n> ')}`).join('\n'), budget));
  }
  if (opts.handoffFile?.trim()) parts.push(`Contenido de ${HANDOFF_FILE.replace(/\\/g, '/')}:`, head(opts.handoffFile.trim(), fileBudget));
  return tail(redactSecrets(parts.join('\n')), max);
}

function describeAttempt(attempt: AttemptResult | undefined): string {
  if (!attempt) return 'sin intentos';
  if (attempt.ok) return 'terminó bien';
  const error = attempt.error ? `${attempt.error.code}: ${attempt.error.message}` : 'sin detalle';
  return `${attempt.outcome} (${error})`;
}

/** Espera `promise` como mucho `ms` (sin dejar temporizadores vivos). */
async function withDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}
function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Tacha secretos en todos los textos de un valor (sin pasar por JSON, para no romper el escape). */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSecrets(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function readUtf8IfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
}
