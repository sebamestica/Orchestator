import type { TaskRecord, TaskState } from '../../api/types.ts';

export interface BoardColumnDef {
  key: string;
  title: string;
  states: readonly string[];
}

export const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  { key: 'pending', title: 'Pendiente', states: ['pending'] },
  { key: 'ready', title: 'Lista', states: ['ready'] },
  { key: 'running', title: 'En curso', states: ['running', 'handed_off'] },
  { key: 'review', title: 'Revisión', states: ['review'] },
  { key: 'integrated', title: 'Integrada', states: ['integrated'] },
  { key: 'failed', title: 'Fallida', states: ['failed'] },
  { key: 'cancelled', title: 'Cancelada', states: ['cancelled'] },
];

export function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return 'Desconocido';
  const timestamp = new Date(isoString).getTime();
  if (Number.isNaN(timestamp)) return 'Desconocido';
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return 'Ahora';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Hace ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Hace ${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Ayer';
  return `Hace ${diffDays} d`;
}

export function difficultyLabel(difficulty: string): string {
  switch (difficulty) {
    case 'low':
      return 'Baja';
    case 'medium':
      return 'Media';
    case 'high':
      return 'Alta';
    default:
      return difficulty;
  }
}

/** Etiqueta en español de cada estado; el `Record` exhaustivo obliga a traducir cualquier estado nuevo. */
export const TASK_STATE_LABEL: Readonly<Record<TaskState, string>> = {
  pending: 'Pendiente',
  ready: 'Lista',
  running: 'En curso',
  review: 'Revisión',
  integrated: 'Integrada',
  failed: 'Fallida',
  handed_off: 'Traspasada',
  cancelled: 'Cancelada',
};

export function taskStateLabel(state: TaskState): string {
  return TASK_STATE_LABEL[state];
}

export function taskMatchesColumn(task: TaskRecord, column: BoardColumnDef): boolean {
  return column.states.includes(task.state);
}
