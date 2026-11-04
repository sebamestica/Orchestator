import type { TaskBrief } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
import type { DelegateResult, FleetPort, FleetTaskStatus } from '../conductor/index.ts';
import type { Fleet, QueueEntry, TaskQueue } from '../orchestrator/index.ts';

export interface FleetRuntimeOptions {
  queue: TaskQueue;
  /** `Fleet` de c2. Sin él (falta el gestor de worktrees de c3) `delegate` responde `accepted: false`. */
  fleet?: Fleet;
  log?: (line: string) => void;
}

export const NO_WORKSPACES_REASON =
  'La flota aún no puede ejecutar tareas: falta el gestor de worktrees (c3). La tarea sigue aprobada y se puede delegar cuando esté.';

function toStatus(e: QueueEntry): FleetTaskStatus {
  return { taskId: e.task.id, state: e.state, updatedAt: e.updatedAt, ...(e.agentId ? { agentId: e.agentId } : {}) };
}

/**
 * `FleetPort` del orquestador sobre la cola y la flota de c2: `delegate` encola la tarea aprobada y, si la flota no
 * está corriendo, la arranca en segundo plano (`Fleet.run` sigue hasta que la cola queda ociosa).
 */
export class FleetRuntime implements FleetPort {
  readonly queue: TaskQueue;
  readonly #fleet: Fleet | undefined;
  readonly #log: (line: string) => void;
  readonly #abort = new AbortController();
  #running: Promise<void> | undefined;

  constructor(opts: FleetRuntimeOptions) {
    this.queue = opts.queue;
    this.#fleet = opts.fleet;
    this.#log = opts.log ?? (() => undefined);
  }

  get canRun(): boolean {
    return this.#fleet !== undefined;
  }

  async delegate(task: TaskBrief): Promise<DelegateResult> {
    if (!this.#fleet) return { accepted: false, reason: NO_WORKSPACES_REASON };
    if (this.#abort.signal.aborted) return { accepted: false, reason: 'La flota se está deteniendo' };
    try {
      this.queue.add(task);
    } catch (err) {
      return { accepted: false, reason: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    this.#kick();
    const entry = this.queue.get(task.id);
    return { accepted: true, ...(entry ? { state: entry.state } : {}), ...(entry?.agentId ? { agentId: entry.agentId } : {}) };
  }

  status(taskId: string): FleetTaskStatus | undefined {
    const entry = this.queue.get(taskId);
    return entry && toStatus(entry);
  }

  list(): FleetTaskStatus[] {
    return this.queue.list().map(toStatus);
  }

  /** Cancela las tareas en curso y espera a que la flota termine. */
  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#running;
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
        // Tareas que quedaron listas justo cuando la flota terminaba.
        if (!this.#abort.signal.aborted && this.queue.list().some((e) => e.state === 'ready')) this.#kick();
      });
  }
}
