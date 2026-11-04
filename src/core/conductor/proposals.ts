import { idSchema, taskBriefSchema } from '../../shared/index.ts';
import type { TaskBrief } from '../../shared/index.ts';
import type { ApprovalState, ProposalStore, ProposedTask } from './ports.ts';

export class ProposalError extends Error {
  override name = 'ProposalError';
}

export interface TaskProposalsOptions {
  now?: () => Date;
}

/**
 * Registro en memoria de las tareas propuestas por el orquestador y de la decisión del usuario.
 * `approve` y `reject` los llama el usuario (UI / API local); el orquestador solo ve `ProposalStore`.
 */
export class TaskProposals implements ProposalStore {
  readonly #entries = new Map<string, ProposedTask>();
  readonly #now: () => Date;

  constructor(opts: TaskProposalsOptions = {}) {
    this.#now = opts.now ?? (() => new Date());
  }

  propose(tasks: readonly TaskBrief[]): ProposedTask[] {
    const parsed = tasks.map((t) => taskBriefSchema.parse(t));
    const seen = new Set<string>();
    for (const task of parsed) {
      if (seen.has(task.id)) throw new ProposalError(`Id repetido en el plan: ${task.id}`);
      seen.add(task.id);
      const current = this.#entries.get(task.id);
      if (current && (current.approval === 'approved' || current.approval === 'delegated')) {
        throw new ProposalError(`La tarea ${task.id} ya está ${label(current.approval)}; usa otro id`);
      }
    }
    const at = this.#now().toISOString();
    // Una tarea propuesta o rechazada se reemplaza: la nueva versión vuelve a esperar aprobación.
    const out = parsed.map((task) => {
      const entry: ProposedTask = { task, approval: 'proposed', proposedAt: at };
      this.#entries.set(task.id, entry);
      return clone(entry);
    });
    return out;
  }

  get(taskId: string): ProposedTask | undefined {
    const entry = this.#entries.get(taskId);
    return entry && clone(entry);
  }

  list(projectId?: string): ProposedTask[] {
    return [...this.#entries.values()].filter((e) => projectId === undefined || e.task.projectId === projectId).map(clone);
  }

  /** Decisión del usuario: aprueba tareas propuestas (todas o ninguna). */
  approve(taskIds: readonly string[]): ProposedTask[] {
    return this.#decide(taskIds, 'approved');
  }

  /** Decisión del usuario: rechaza tareas propuestas o aprobadas que aún no se delegaron. */
  reject(taskIds: readonly string[]): ProposedTask[] {
    return this.#decide(taskIds, 'rejected');
  }

  markDelegated(taskId: string): ProposedTask {
    const entry = this.#entries.get(taskId);
    if (!entry) throw new ProposalError(`No existe la tarea ${taskId}`);
    if (entry.approval !== 'approved') throw new ProposalError(`La tarea ${taskId} está ${label(entry.approval)}, no aprobada`);
    entry.approval = 'delegated';
    entry.delegatedAt = this.#now().toISOString();
    return clone(entry);
  }

  #decide(taskIds: readonly string[], to: 'approved' | 'rejected'): ProposedTask[] {
    const ids = [...new Set(taskIds.map((id) => idSchema.parse(id)))];
    const entries = ids.map((id) => {
      const entry = this.#entries.get(id);
      if (!entry) throw new ProposalError(`No existe la tarea ${id}`);
      const allowed: readonly ApprovalState[] = to === 'approved' ? ['proposed', 'approved'] : ['proposed', 'approved', 'rejected'];
      if (!allowed.includes(entry.approval)) throw new ProposalError(`La tarea ${id} está ${label(entry.approval)}`);
      return entry;
    });
    const at = this.#now().toISOString();
    for (const entry of entries) {
      entry.approval = to;
      entry.decidedAt = at;
    }
    return entries.map(clone);
  }
}

export function label(state: ApprovalState): string {
  switch (state) {
    case 'proposed': return 'propuesta (pendiente de aprobación del usuario)';
    case 'approved': return 'aprobada';
    case 'rejected': return 'rechazada por el usuario';
    case 'delegated': return 'delegada';
  }
}

function clone(entry: ProposedTask): ProposedTask {
  return structuredClone(entry);
}
