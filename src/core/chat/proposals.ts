/**
 * Propuestas de un chat en SQLite (`chat_proposals`), detrás del mismo puerto que `TaskProposals` (`ProposalStore`)
 * más la decisión del usuario (`approve`/`reject`). Los ids de tarea son únicos en todo el núcleo: al aprobar, la
 * tarea entra en el tablero (`tasks`) con ese id.
 */
import { z } from 'zod';
import { idSchema, taskBriefSchema } from '../../shared/index.ts';
import type { Proposal, TaskBrief } from '../../shared/index.ts';
import { ProposalError, label } from '../conductor/index.ts';
import type { ApprovableProposals, ApprovalState, ProposedTask } from '../conductor/index.ts';
import type { ChatDb } from './db.ts';

const approvalSchema = z.enum(['proposed', 'approved', 'rejected', 'delegated']);
const row = z.object({
  task_id: z.string(),
  chat_id: z.string(),
  brief_json: z.string(),
  approval: z.string(),
  proposed_at: z.string(),
  decided_at: z.string().nullable(),
  delegated_at: z.string().nullable(),
});

function toEntry(raw: unknown): ProposedTask & { chatId: string } {
  const r = row.parse(raw);
  return {
    chatId: r.chat_id,
    task: taskBriefSchema.parse(JSON.parse(r.brief_json)),
    approval: approvalSchema.parse(r.approval),
    proposedAt: r.proposed_at,
    ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
    ...(r.delegated_at ? { delegatedAt: r.delegated_at } : {}),
  };
}

/** Forma pública (`proposalSchema` es estricto: sin fechas de decisión). */
export function toProposal(entry: ProposedTask): Proposal {
  return { task: entry.task, approval: entry.approval, proposedAt: entry.proposedAt };
}

export interface ChatProposalsOptions {
  now?: () => Date;
  /** Se llama tras cada cambio (para difundir `{type:'proposals'}`). */
  onChange?: () => void;
  /** Motivo si el id ya está ocupado fuera de las propuestas (p. ej. una tarea del tablero). */
  taken?: (taskId: string) => string | undefined;
}

const SELECT = 'SELECT task_id, chat_id, brief_json, approval, proposed_at, decided_at, delegated_at FROM chat_proposals';

export class ChatProposals implements ApprovableProposals {
  readonly chatId: string;
  readonly #db: ChatDb;
  readonly #now: () => Date;
  readonly #onChange: () => void;
  readonly #taken: (taskId: string) => string | undefined;

  constructor(db: ChatDb, chatId: string, opts: ChatProposalsOptions = {}) {
    this.#db = db;
    this.chatId = chatId;
    this.#now = opts.now ?? (() => new Date());
    this.#onChange = opts.onChange ?? (() => undefined);
    this.#taken = opts.taken ?? (() => undefined);
  }

  /** Ids de tarea propuestos en cualquier chat del proyecto (para que el planificador no los repita). */
  static idsForProject(db: ChatDb, projectId: string): string[] {
    return db
      .stmt('SELECT task_id FROM chat_proposals WHERE project_id = ?')
      .all(projectId)
      .map((r) => z.object({ task_id: z.string() }).parse(r).task_id);
  }

  propose(tasks: readonly TaskBrief[]): ProposedTask[] {
    const parsed = tasks.map((t) => taskBriefSchema.parse(t));
    const seen = new Set<string>();
    for (const task of parsed) {
      if (seen.has(task.id)) throw new ProposalError(`Id repetido en el plan: ${task.id}`);
      seen.add(task.id);
      const current = this.#any(task.id);
      if (current && current.chatId !== this.chatId) throw new ProposalError(`El id ${task.id} ya lo usa otra conversación; usa otro id`);
      if (current && (current.approval === 'approved' || current.approval === 'delegated')) {
        throw new ProposalError(`La tarea ${task.id} ya está ${label(current.approval)}; usa otro id`);
      }
      if (!current) {
        const why = this.#taken(task.id);
        if (why) throw new ProposalError(why);
      }
    }
    const at = this.#now().toISOString();
    // Una tarea propuesta o rechazada se reemplaza: la nueva versión vuelve a esperar aprobación.
    this.#db.tx(() => {
      for (const task of parsed) {
        this.#db
          .stmt(
            `INSERT INTO chat_proposals (task_id, chat_id, project_id, brief_json, approval, proposed_at, decided_at, delegated_at)
             VALUES (?, ?, ?, ?, 'proposed', ?, NULL, NULL)
             ON CONFLICT(task_id) DO UPDATE SET project_id = excluded.project_id, brief_json = excluded.brief_json,
               approval = 'proposed', proposed_at = excluded.proposed_at, decided_at = NULL, delegated_at = NULL`,
          )
          .run(task.id, this.chatId, task.projectId, JSON.stringify(task), at);
      }
    });
    this.#onChange();
    return parsed.map((t) => this.#require(t.id));
  }

  get(taskId: string): ProposedTask | undefined {
    const entry = this.#any(taskId);
    return entry && entry.chatId === this.chatId ? strip(entry) : undefined;
  }

  list(projectId?: string): ProposedTask[] {
    return this.#db
      .stmt(`${SELECT} WHERE chat_id = ? ORDER BY proposed_at, rowid`)
      .all(this.chatId)
      .map(toEntry)
      .filter((e) => projectId === undefined || e.task.projectId === projectId)
      .map(strip);
  }

  /** Decisión del usuario (o del modo auto): aprueba tareas propuestas (todas o ninguna). */
  approve(taskIds: readonly string[]): ProposedTask[] {
    return this.#decide(taskIds, 'approved');
  }

  /** Decisión del usuario: rechaza tareas propuestas o aprobadas que aún no se delegaron. */
  reject(taskIds: readonly string[]): ProposedTask[] {
    return this.#decide(taskIds, 'rejected');
  }

  markDelegated(taskId: string): ProposedTask {
    const entry = this.get(taskId);
    if (!entry) throw new ProposalError(`No existe la tarea ${taskId}`);
    if (entry.approval !== 'approved') throw new ProposalError(`La tarea ${taskId} está ${label(entry.approval)}, no aprobada`);
    this.#db.stmt(`UPDATE chat_proposals SET approval = 'delegated', delegated_at = ? WHERE task_id = ?`).run(this.#now().toISOString(), taskId);
    this.#onChange();
    return this.#require(taskId);
  }

  /** Lista pública del chat. */
  proposals(): Proposal[] {
    return this.list().map(toProposal);
  }

  #decide(taskIds: readonly string[], to: 'approved' | 'rejected'): ProposedTask[] {
    const ids = [...new Set(taskIds.map((id) => idSchema.parse(id)))];
    const allowed: readonly ApprovalState[] = to === 'approved' ? ['proposed', 'approved'] : ['proposed', 'approved', 'rejected'];
    for (const id of ids) {
      const entry = this.get(id);
      if (!entry) throw new ProposalError(`No existe la tarea ${id}`);
      if (!allowed.includes(entry.approval)) throw new ProposalError(`La tarea ${id} está ${label(entry.approval)}`);
    }
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      for (const id of ids) this.#db.stmt('UPDATE chat_proposals SET approval = ?, decided_at = ? WHERE task_id = ?').run(to, at, id);
    });
    if (ids.length) this.#onChange();
    return ids.map((id) => this.#require(id));
  }

  #any(taskId: string): (ProposedTask & { chatId: string }) | undefined {
    const raw = this.#db.stmt(`${SELECT} WHERE task_id = ?`).get(taskId);
    return raw ? toEntry(raw) : undefined;
  }

  #require(taskId: string): ProposedTask {
    const entry = this.get(taskId);
    if (!entry) throw new ProposalError(`No existe la tarea ${taskId}`);
    return entry;
  }
}

function strip(entry: ProposedTask & { chatId?: string }): ProposedTask {
  const { chatId: _chatId, ...rest } = entry;
  return rest;
}
