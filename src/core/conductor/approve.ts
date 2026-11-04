/**
 * Aprobación del usuario con entrega a la flota (modo plan): la tarea aprobada pasa directo a la cola, en orden de
 * dependencias. La usan el chat (`POST /chats/:id/proposals/:taskId/approve`) y la terminal (`/aprobar`).
 * El modelo nunca llega aquí: aprobar es del usuario.
 */
import { redactSecrets } from '../../shared/index.ts';
import type { TaskBrief } from '../../shared/index.ts';
import type { Awaitable, FleetPort, ProposalStore, ProposedTask } from './ports.ts';

/** Propuestas que además aceptan la decisión del usuario (`TaskProposals`, `ChatProposals`). */
export interface ApprovableProposals extends ProposalStore {
  approve(taskIds: readonly string[]): Awaitable<readonly ProposedTask[]>;
  reject(taskIds: readonly string[]): Awaitable<readonly ProposedTask[]>;
}

export interface DeliveryReport {
  /** Tareas que la flota aceptó (quedan `delegated`). */
  delivered: string[];
  /** Tareas aprobadas que no se entregaron, con el motivo (siguen `approved`: se pueden reintentar). */
  failed: { taskId: string; reason: string }[];
}

/** Ordena por dependencias dentro del lote (las de fuera no cuentan); ante un ciclo conserva el orden recibido. */
export function dependencyOrder(tasks: readonly TaskBrief[]): TaskBrief[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const out: TaskBrief[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (task: TaskBrief) => {
    if (state.get(task.id)) return;
    state.set(task.id, 'visiting');
    for (const dep of task.dependsOn) {
      const d = byId.get(dep);
      if (d && !state.get(dep)) visit(d);
    }
    state.set(task.id, 'done');
    out.push(task);
  };
  for (const t of tasks) visit(t);
  return out;
}

/**
 * Aprueba (todas o ninguna, como `approve`) y entrega cada tarea a la flota en orden de dependencias. Una tarea cuya
 * dependencia no está en la flota, o que la flota rechaza, queda aprobada y se informa en `failed`.
 */
export async function approveAndDeliver(proposals: ApprovableProposals, fleet: FleetPort, taskIds: readonly string[]): Promise<DeliveryReport> {
  const approved = await proposals.approve(taskIds);
  const report: DeliveryReport = { delivered: [], failed: [] };
  for (const task of dependencyOrder(approved.map((e) => e.task))) {
    const missing: string[] = [];
    for (const dep of task.dependsOn) {
      if ((await proposals.get(dep))?.approval === 'delegated') continue;
      if (await fleet.status(dep)) continue;
      missing.push(dep);
    }
    if (missing.length) {
      report.failed.push({ taskId: task.id, reason: `depende de ${missing.join(', ')}, que aún no está en la flota: apruébala antes` });
      continue;
    }
    let result: Awaited<ReturnType<FleetPort['delegate']>>;
    try {
      result = await fleet.delegate(task);
    } catch (err) {
      result = { accepted: false, reason: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    if (!result.accepted) {
      report.failed.push({ taskId: task.id, reason: result.reason });
      continue;
    }
    await proposals.markDelegated(task.id);
    report.delivered.push(task.id);
  }
  return report;
}
