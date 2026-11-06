import type { TaskBrief, TaskState } from '../../shared/index.ts';
import { PLAN_FILES, redactSecrets } from '../../shared/index.ts';
import type { DelegateResult, FleetPort, FleetTaskStatus } from '../conductor/index.ts';
import type { Fleet, QueueEntry, TaskQueue } from '../orchestrator/index.ts';

/** Lo que la flota necesita de una tarea guardada (SQLite) para reintentarla o informarla tras un reinicio. */
export interface SavedTask {
  task: TaskBrief;
  state: TaskState;
  agentId: string | null;
  detail: string | null;
  attempts: number;
  updatedAt: string;
}

export interface FleetRuntimeOptions {
  queue: TaskQueue;
  /** `Fleet` de c2. Sin él (falta el gestor de worktrees de c3) `delegate` responde `accepted: false`. */
  fleet?: Fleet;
  log?: (line: string) => void;
  /**
   * Tareas guardadas (el almacén). Con él, `retry` vuelve a encolar desde la base una tarea fallida que la cola ya no
   * tiene (después de reiniciar el núcleo) y `status` informa las tareas terminadas que la cola no conoce.
   */
  saved?: (taskId: string) => SavedTask | undefined;
}

export const NO_WORKSPACES_REASON =
  'La flota aún no puede ejecutar tareas: falta el gestor de worktrees (c3). La tarea sigue aprobada y se puede delegar cuando esté.';

/** Motivo por omisión de un reintento (queda en el cambio `failed → ready`). */
export const RETRY_DETAIL = 'reintento pedido';

/** Estados en los que la base dice la verdad aunque la cola no tenga la tarea (terminadas o fallidas). */
const SETTLED: ReadonlySet<TaskState> = new Set(['failed', 'integrated', 'cancelled']);

function toStatus(e: QueueEntry): FleetTaskStatus {
  return { taskId: e.task.id, state: e.state, updatedAt: e.updatedAt, ...(e.agentId ? { agentId: e.agentId } : {}) };
}

/**
 * Estado de una tarea para la mente: el de la cola (con el motivo del último cambio) o, si la cola no la tiene, el
 * guardado de una tarea terminada o fallida (p. ej. después de reiniciar el núcleo).
 */
export function fleetTaskStatus(entry: QueueEntry | undefined, saved: SavedTask | undefined, liveDetail?: string): FleetTaskStatus | undefined {
  if (entry) {
    const detail = liveDetail ?? (saved?.state === entry.state ? saved.detail : null);
    return { ...toStatus(entry), ...(detail ? { detail } : {}) };
  }
  if (!saved || !SETTLED.has(saved.state)) return undefined;
  return {
    taskId: saved.task.id,
    state: saved.state,
    updatedAt: saved.updatedAt,
    ...(saved.agentId ? { agentId: saved.agentId } : {}),
    ...(saved.detail ? { detail: saved.detail } : {}),
  };
}

function oneLine(text: string, max = 600): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * El encargo con la sección «Continuación» al final del objetivo: la tarea ya se intentó y su worktree (o la carpeta
 * local) conserva lo hecho. El agente parte del último motivo y de `.orq/PLAN-TAREA.md` en lugar de empezar de cero.
 */
export function withContinuation(task: TaskBrief, info: { reason?: string | null; attempt?: number } = {}): TaskBrief {
  const reason = info.reason?.trim() ? redactSecrets(oneLine(info.reason)) : undefined;
  const objective = [
    task.objective,
    '',
    `### Continuación${info.attempt && info.attempt > 1 ? ` (intento ${info.attempt})` : ''}`,
    `Esta tarea ya se intentó y no terminó.${reason ? ` Último motivo: ${reason}` : ''}`,
    'Si en esta carpeta quedó trabajo del intento anterior, continúa desde ahí sin rehacer lo que ya funciona:',
    `- relee \`${PLAN_FILES.taskPlan}\` si existe: comprueba lo marcado como hecho y sigue con los pasos pendientes;`,
    `- lee \`${PLAN_FILES.handoff}\` si existe y revisa el estado de los archivos (\`git status\` y \`git diff\` si la carpeta es git);`,
    '- corrige la causa del último motivo antes de seguir.',
  ].join('\n');
  return { ...task, objective };
}

/**
 * `FleetPort` del orquestador sobre la cola y la flota de c2: `delegate` encola la tarea aprobada y, si la flota no
 * está corriendo, la arranca en segundo plano (`Fleet.run` sigue hasta que la cola queda ociosa). `retry` vuelve a
 * poner en marcha una tarea fallida.
 */
export class FleetRuntime implements FleetPort {
  readonly queue: TaskQueue;
  readonly #fleet: Fleet | undefined;
  readonly #log: (line: string) => void;
  readonly #saved: (taskId: string) => SavedTask | undefined;
  readonly #abort = new AbortController();
  /** Encargo original de cada tarea reintentada (las secciones «Continuación» no se acumulan). */
  readonly #originals = new Map<string, TaskBrief>();
  /** Motivo del último cambio de estado de cada tarea de la cola. */
  readonly #details = new Map<string, string>();
  #running: Promise<void> | undefined;

  constructor(opts: FleetRuntimeOptions) {
    this.queue = opts.queue;
    this.#fleet = opts.fleet;
    this.#log = opts.log ?? (() => undefined);
    this.#saved = opts.saved ?? (() => undefined);
    this.queue.on((change) => {
      if (change.detail) this.#details.set(change.taskId, redactSecrets(change.detail));
      else this.#details.delete(change.taskId);
    });
  }

  get canRun(): boolean {
    return this.#fleet !== undefined;
  }

  async delegate(task: TaskBrief): Promise<DelegateResult> {
    if (!this.#fleet) return { accepted: false, reason: NO_WORKSPACES_REASON };
    if (this.#abort.signal.aborted) return { accepted: false, reason: 'La flota se está deteniendo' };
    try {
      this.queue.add(this.#withLiveDeps(task));
    } catch (err) {
      return { accepted: false, reason: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    this.#kick();
    const entry = this.queue.get(task.id);
    return { accepted: true, ...(entry ? { state: entry.state } : {}), ...(entry?.agentId ? { agentId: entry.agentId } : {}) };
  }

  /**
   * Reintenta una tarea `failed`:
   * - si la cola la tiene, `failed → ready` con el encargo de continuación;
   * - si no (el núcleo se reinició), la vuelve a encolar desde la base con su encargo guardado. Sus dependencias ya
   *   integradas (en la base) no hacen falta en la cola; una que no esté integrada ni en la cola impide el reintento.
   * El worktree conservado de la tarea (o la carpeta local con su `.orq/`) se reutiliza al crear el workspace.
   */
  async retry(taskId: string, reason: string = RETRY_DETAIL): Promise<DelegateResult> {
    if (!this.#fleet) return { accepted: false, reason: NO_WORKSPACES_REASON };
    if (this.#abort.signal.aborted) return { accepted: false, reason: 'La flota se está deteniendo' };
    const entry = this.queue.get(taskId);
    const saved = this.#saved(taskId);
    const state = entry?.state ?? saved?.state;
    if (state === undefined) return { accepted: false, reason: `No existe la tarea ${taskId}` };
    if (state !== 'failed') return { accepted: false, reason: `La tarea ${taskId} está en estado ${state}: solo se reintenta una tarea fallida` };
    const original = this.#originals.get(taskId) ?? saved?.task ?? entry?.task;
    if (!original) return { accepted: false, reason: `No existe la tarea ${taskId}` };
    this.#originals.set(taskId, original);
    const lastReason = (entry ? this.#details.get(taskId) : undefined) ?? saved?.detail ?? undefined;
    const brief = withContinuation(original, { reason: lastReason, ...(saved ? { attempt: saved.attempts + 1 } : {}) });
    const detail = redactSecrets(reason).slice(0, 300) || RETRY_DETAIL;
    try {
      if (entry) {
        this.queue.retry(taskId, detail, brief);
      } else {
        const missing = brief.dependsOn.filter((dep) => !this.queue.get(dep) && this.#saved(dep)?.state !== 'integrated');
        if (missing.length) {
          const states = missing.map((dep) => `${dep} (${this.#saved(dep)?.state ?? 'no existe'})`).join(', ');
          return { accepted: false, reason: `La tarea ${taskId} depende de ${states}, que no está integrada ni en la flota: reintenta o delega antes esa tarea` };
        }
        this.queue.add(this.#withLiveDeps(brief));
      }
    } catch (err) {
      return { accepted: false, reason: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    this.#log(`flota: ${taskId} reintentada (${entry ? 'en la cola' : 'desde la base'})`);
    this.#kick();
    const now = this.queue.get(taskId);
    return {
      accepted: true,
      ...(now ? { state: now.state } : {}),
      ...(now?.agentId ? { agentId: now.agentId } : {}),
      detail: entry ? 'reintentada en la cola de la flota' : 'reencolada desde la base (el núcleo se reinició)',
    };
  }

  /** Estado en la cola o, si la cola no la tiene, el guardado de una tarea terminada o fallida; con su motivo. */
  status(taskId: string): FleetTaskStatus | undefined {
    const entry = this.queue.get(taskId);
    return fleetTaskStatus(entry, this.#saved(taskId), entry ? this.#details.get(taskId) : undefined);
  }

  list(): FleetTaskStatus[] {
    return this.queue.list().map(toStatus);
  }

  /** Cancela las tareas en curso y espera a que la flota termine. */
  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#running;
  }

  /**
   * Quita las dependencias que la cola no tiene pero la base da por integradas (p. ej. tras reiniciar el núcleo): ya
   * se cumplieron. Las demás quedan y `queue.add` decide.
   */
  #withLiveDeps(task: TaskBrief): TaskBrief {
    const dependsOn = task.dependsOn.filter((dep) => this.queue.get(dep) || this.#saved(dep)?.state !== 'integrated');
    return dependsOn.length === task.dependsOn.length ? task : { ...task, dependsOn };
  }

  #kick(): void {
    const fleet = this.#fleet;
    if (!fleet || this.#running) return;
    this.#running = fleet
      .run({ signal: this.#abort.signal })
      .then((report) => this.#log(`flota: ${report.tasks.length} tareas terminadas`))
      .catch((err: unknown) => this.#log(redactSecrets(`flota: ${err instanceof Error ? err.message : String(err)}`).slice(0, 300)))
      .finally(() => {
        this.#running = undefined;
        // Tareas que quedaron listas justo cuando la flota terminaba. Sin cupo no se relanza: ese run() saldría sin
        // esperar nada y el relanzamiento sería un bucle de microtareas que congela el núcleo.
        const hasRoom = this.queue.active < this.queue.concurrency;
        if (!this.#abort.signal.aborted && hasRoom && this.queue.list().some((e) => e.state === 'ready')) this.#kick();
      });
  }
}
