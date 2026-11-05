import type { TaskBrief, TaskState } from '../../shared/index.ts';
import { findCycles } from './graph.ts';

export const DEFAULT_CONCURRENCY = 3;

/** Transiciones permitidas. `handed_off` y `review` conservan el cupo de concurrencia de la tarea. */
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ['ready', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['review', 'handed_off', 'failed', 'cancelled'],
  handed_off: ['running', 'failed', 'cancelled'],
  // review → running: rechazo o fallo de integración, vuelve al autor.
  review: ['running', 'integrated', 'failed', 'cancelled'],
  failed: ['ready', 'cancelled'],
  integrated: [],
  cancelled: [],
};
const ACTIVE: ReadonlySet<TaskState> = new Set(['running', 'handed_off', 'review']);
const TERMINAL: ReadonlySet<TaskState> = new Set(['integrated', 'cancelled']);

export interface TaskStateChange {
  taskId: string;
  from: TaskState | null;
  to: TaskState;
  at: string;
  agentId?: string;
  detail?: string;
}
export type TaskStateListener = (change: TaskStateChange) => void;

export interface QueueEntry {
  task: TaskBrief;
  state: TaskState;
  /** Agente que la tiene ahora (o la tuvo por última vez). */
  agentId?: string;
  updatedAt: string;
}

export interface TaskQueueOptions {
  concurrency?: number;
  now?: () => Date;
}

export class QueueError extends Error {
  override name = 'QueueError';
}

/**
 * Planificador DAG. Una tarea pasa a `ready` cuando todas sus dependencias están `integrated`;
 * `next()` entrega tareas listas en orden de llegada sin superar el límite de concurrencia
 * (cuentan `running`, `handed_off` y `review`).
 */
export class TaskQueue {
  readonly #entries = new Map<string, QueueEntry>();
  readonly #listeners = new Set<TaskStateListener>();
  readonly #now: () => Date;
  #concurrency: number;

  constructor(opts: TaskQueueOptions = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.#concurrency = checkConcurrency(opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  get concurrency(): number {
    return this.#concurrency;
  }
  set concurrency(value: number) {
    this.#concurrency = checkConcurrency(value);
  }

  /** Tareas que ocupan cupo de concurrencia. */
  get active(): number {
    let n = 0;
    for (const e of this.#entries.values()) if (ACTIVE.has(e.state)) n++;
    return n;
  }

  on(listener: TaskStateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Agrega tareas. Las dependencias deben existir (en la cola o en el mismo lote) y no formar ciclos. */
  addAll(tasks: readonly TaskBrief[]): void {
    const incoming = new Map<string, TaskBrief>();
    for (const t of tasks) {
      if (this.#entries.has(t.id) || incoming.has(t.id)) throw new QueueError(`La tarea ${t.id} ya está en la cola.`);
      incoming.set(t.id, t);
    }
    for (const t of incoming.values()) {
      for (const dep of t.dependsOn) {
        if (!this.#entries.has(dep) && !incoming.has(dep)) throw new QueueError(`La tarea ${t.id} depende de ${dep}, que no está en la cola.`);
      }
    }
    const cycles = findCycles([...[...this.#entries.values()].map((e) => e.task), ...incoming.values()]);
    const first = cycles[0];
    if (first) throw new QueueError(`Ciclo de dependencias: ${first.join(' → ')}`);

    const changes: TaskStateChange[] = [];
    for (const t of incoming.values()) {
      this.#entries.set(t.id, { task: t, state: 'pending', updatedAt: this.#now().toISOString() });
      changes.push(this.#change(t.id, null, 'pending'));
    }
    // Un requisito ya cancelado no se integrará nunca: la cancelación se propaga al agregar (si no, la tarea
    // quedaría `pending` para siempre con la cola ociosa).
    for (const t of incoming.values()) {
      const entry = this.#require(t.id);
      const cancelledDep = t.dependsOn.find((dep) => this.#entries.get(dep)?.state === 'cancelled');
      if (entry.state !== 'pending' || cancelledDep === undefined) continue;
      this.#set(entry, 'cancelled', { detail: `dependencia ${cancelledDep} cancelada` }, changes);
      this.#cancelDependents(t.id, changes);
    }
    for (const t of incoming.values()) this.#promoteIfReady(t.id, changes);
    this.#emit(changes);
  }

  add(task: TaskBrief): void {
    this.addAll([task]);
  }

  get(taskId: string): QueueEntry | undefined {
    const e = this.#entries.get(taskId);
    return e ? { ...e } : undefined;
  }

  state(taskId: string): TaskState {
    return this.#require(taskId).state;
  }

  list(): QueueEntry[] {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  /**
   * Toma la siguiente tarea lista (pasa a `running`) si hay cupo de concurrencia. `canStart` permite saltar tareas
   * listas que aún no pueden empezar (p. ej. otra tarea trabaja en la misma carpeta local): siguen `ready` y se
   * prueba la siguiente en orden de llegada.
   */
  next(canStart?: (task: TaskBrief) => boolean): TaskBrief | undefined {
    if (this.active >= this.#concurrency) return undefined;
    for (const e of this.#entries.values()) {
      if (e.state === 'ready' && (!canStart || canStart(e.task))) {
        this.transition(e.task.id, 'running');
        return e.task;
      }
    }
    return undefined;
  }

  /** Cambia el estado validando la transición. Integrar libera a las dependientes; cancelar las cancela. */
  transition(taskId: string, to: TaskState, info: { agentId?: string; detail?: string } = {}): void {
    const entry = this.#require(taskId);
    const from = entry.state;
    if (!TRANSITIONS[from].includes(to)) throw new QueueError(`Transición no permitida para ${taskId}: ${from} → ${to}.`);
    const changes: TaskStateChange[] = [];
    this.#set(entry, to, info, changes);
    if (to === 'integrated') {
      for (const dependent of this.#dependentsOf(taskId)) this.#promoteIfReady(dependent.task.id, changes);
    }
    if (to === 'cancelled') this.#cancelDependents(taskId, changes);
    this.#emit(changes);
  }

  /** Anota el agente que tiene la tarea ahora (sin cambiar su estado). */
  assign(taskId: string, agentId: string): void {
    const entry = this.#require(taskId);
    entry.agentId = agentId;
    entry.updatedAt = this.#now().toISOString();
  }

  /** True si la transición está permitida desde el estado actual. */
  canTransition(taskId: string, to: TaskState): boolean {
    const entry = this.#entries.get(taskId);
    return entry !== undefined && TRANSITIONS[entry.state].includes(to);
  }

  /** Cancela una tarea que no haya terminado y, en cascada, las que dependen de ella. */
  cancel(taskId: string, detail?: string): boolean {
    const entry = this.#require(taskId);
    if (TERMINAL.has(entry.state)) return false;
    this.transition(taskId, 'cancelled', { detail });
    return true;
  }

  /** Reintenta una tarea fallida. */
  retry(taskId: string, detail?: string): void {
    this.transition(taskId, 'ready', { detail });
  }

  /** True si no hay tareas activas ni listas (las pendientes que quedan están bloqueadas). */
  isIdle(): boolean {
    for (const e of this.#entries.values()) if (ACTIVE.has(e.state) || e.state === 'ready') return false;
    return true;
  }

  #require(taskId: string): QueueEntry {
    const e = this.#entries.get(taskId);
    if (!e) throw new QueueError(`La tarea ${taskId} no está en la cola.`);
    return e;
  }

  #set(entry: QueueEntry, to: TaskState, info: { agentId?: string; detail?: string }, changes: TaskStateChange[]): void {
    const from = entry.state;
    entry.state = to;
    entry.updatedAt = this.#now().toISOString();
    if (info.agentId) entry.agentId = info.agentId;
    changes.push(this.#change(entry.task.id, from, to, { agentId: info.agentId ?? entry.agentId, detail: info.detail }));
  }

  #change(taskId: string, from: TaskState | null, to: TaskState, info: { agentId?: string; detail?: string } = {}): TaskStateChange {
    const change: TaskStateChange = { taskId, from, to, at: this.#now().toISOString() };
    if (info.agentId) change.agentId = info.agentId;
    if (info.detail) change.detail = info.detail;
    return change;
  }

  #promoteIfReady(taskId: string, changes: TaskStateChange[]): void {
    const entry = this.#require(taskId);
    if (entry.state !== 'pending') return;
    const ready = entry.task.dependsOn.every((dep) => this.#entries.get(dep)?.state === 'integrated');
    if (ready) this.#set(entry, 'ready', {}, changes);
  }

  #dependentsOf(taskId: string): QueueEntry[] {
    return [...this.#entries.values()].filter((e) => e.task.dependsOn.includes(taskId));
  }

  #cancelDependents(taskId: string, changes: TaskStateChange[]): void {
    for (const dependent of this.#dependentsOf(taskId)) {
      if (TERMINAL.has(dependent.state) || ACTIVE.has(dependent.state)) continue;
      this.#set(dependent, 'cancelled', { detail: `dependencia ${taskId} cancelada` }, changes);
      this.#cancelDependents(dependent.task.id, changes);
    }
  }

  #emit(changes: readonly TaskStateChange[]): void {
    for (const change of changes) {
      for (const listener of this.#listeners) {
        try {
          listener(change);
        } catch (err) {
          console.error(`Error en un oyente de la cola: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}

function checkConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new QueueError(`Concurrencia inválida: ${value}. Debe ser un entero ≥ 1.`);
  return value;
}
