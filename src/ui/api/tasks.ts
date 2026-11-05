import { api, ApiError } from './client.ts';
import type { TaskRecord } from './types.ts';

/** `POST /tasks/:id/retry`: vuelve a poner en marcha una tarea fallida. Devuelve la tarea ya actualizada. */
export async function retryTask(taskId: string): Promise<TaskRecord> {
  const res = await api.post<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(taskId)}/retry`, {});
  return res.task;
}

/** Aviso para el usuario cuando una acción sobre una tarea falla («al reintentar la tarea», «al aprobar…»). */
export function taskActionError(action: string, err: unknown): string {
  if (err instanceof ApiError) return `Aviso: Error ${err.status} (${err.code}) ${action}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Hora más reciente entre el último cambio de estado y el último evento de sus agentes (el avance real). */
export function lastActivity(task: Pick<TaskRecord, 'updatedAt' | 'createdAt' | 'lastEventAt'>): string {
  const updated = task.updatedAt || task.createdAt;
  const event = task.lastEventAt;
  if (!event) return updated;
  return new Date(event).getTime() > new Date(updated).getTime() ? event : updated;
}
