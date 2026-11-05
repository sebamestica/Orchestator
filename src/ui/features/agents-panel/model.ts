import { z } from 'zod';
import { agentEventSchema, sessionStateSchema } from '../../../shared/events.ts';
import type { Chat } from '../../../shared/api.ts';
import type { AgentEvent, SessionRecord, TaskRecord } from '../../api/types.ts';

export const sessionSchema = z.object({
  id: z.string(), agentId: z.string(), taskId: z.string().nullable(), parentSessionId: z.string().nullable(),
  state: sessionStateSchema, startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(), lastSeq: z.number().int().min(-1),
  role: z.enum(['author', 'reviewer']).optional(),
});
export const sessionsSchema = z.object({ sessions: z.array(sessionSchema) });
export const sessionResponseSchema = z.object({ session: sessionSchema });
export interface SessionView {
  session: SessionRecord & { role?: 'author' | 'reviewer' };
  latest?: AgentEvent;
  action?: AgentEvent;
}
export const initialView = (session: SessionView['session']): SessionView => ({ session });
export const isActive = ({ session }: SessionView) => ['starting', 'running', 'waiting'].includes(session.state);
export const STALE_MS = 10 * 60 * 1000;

export function applyEvents(current: Record<string, SessionView>, incoming: readonly unknown[]): Record<string, SessionView> {
  const next = { ...current };
  for (const item of incoming) {
    const parsed = agentEventSchema.safeParse(item);
    if (!parsed.success) continue;
    const event = parsed.data;
    const previous = next[event.sessionId] ?? initialView({ id: event.sessionId, agentId: event.agentId,
      taskId: null, parentSessionId: event.parentSessionId ?? null, state: 'running', startedAt: event.ts,
      updatedAt: event.ts, endedAt: null, lastSeq: -1 });
    const newer = !previous.latest || event.seq > previous.latest.seq;
    const newAction = event.type !== 'usage' && (!previous.action || event.seq > previous.action.seq);
    if (!newer && !newAction) continue;
    const currentState = event.seq >= previous.session.lastSeq;
    const state = !currentState ? previous.session.state : event.type === 'status' ? event.payload.state : event.type === 'done' ? (event.payload.ok ? 'done' : 'failed') : previous.session.state;
    next[event.sessionId] = { ...previous, ...(newer ? { latest: event } : {}),
      ...(newAction ? { action: event } : {}),
      session: { ...previous.session, state, updatedAt: currentState ? event.ts : previous.session.updatedAt, lastSeq: Math.max(event.seq, previous.session.lastSeq),
        parentSessionId: event.parentSessionId ?? previous.session.parentSessionId } };
  }
  return next;
}

export function actionText(event?: AgentEvent): string {
  switch (event?.type) {
    case 'tool_call': return `${event.payload.name} · ${event.payload.inputSummary}`;
    case 'tool_result': return event.payload.summary;
    case 'status': return event.payload.detail ?? 'Esperando actividad…';
    case 'error': return event.payload.message;
    case 'done': return event.payload.summary ?? 'Tarea terminada';
    case 'text': return event.payload.role === 'thinking-summary' ? 'pensando…' : 'Redactando respuesta…';
    case 'file_change': return 'Editando archivos…';
    default: return 'pensando…';
  }
}

export interface ActivityRow {
  status: string;
  line: string;
  active: boolean;
  thinking?: boolean;
}

export function selectChat(chats: readonly Chat[], opened: Chat | null): Chat | undefined {
  const all = opened ? [opened, ...chats.filter((chat) => chat.id !== opened.id)] : [...chats];
  return all.find((chat) => chat.state === 'running')
    ?? all.find((chat) => (chat.backgroundTasks ?? 0) > 0 && chat.state !== 'closed')
    ?? opened ?? all[0];
}

export function mindRow(chat: Chat | undefined, views: Record<string, SessionView>, events: readonly AgentEvent[]): ActivityRow {
  const thinking = chat?.state === 'running';
  const background = chat?.state !== 'closed' && (chat?.backgroundTasks ?? 0) > 0;
  const active = thinking || background;
  const candidates = [...events, ...Object.values(views).flatMap((view) => view.action ? [view.action] : [])]
    .filter((event) => event.type !== 'usage' && chat && (event.sessionId === chat.sessionId || event.parentSessionId === chat.sessionId));
  candidates.sort((a, b) => b.ts.localeCompare(a.ts) || b.seq - a.seq);
  return { status: chat?.state === 'error' ? 'Error' : thinking ? 'Pensando' : background ? 'Trabajando en segundo plano' : 'Libre',
    line: active || chat?.state === 'error' ? actionText(candidates[0]) : 'Lista para ayudarte', active: active && chat?.state !== 'error', thinking };
}

export function workerRow(agentId: string, views: Record<string, SessionView>, tasks: Record<string, TaskRecord>, now: number): ActivityRow {
  const all = Object.values(views).filter((view) => view.session.agentId === agentId && !view.session.parentSessionId && !view.session.id.startsWith('chat-'));
  all.sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.session.updatedAt.localeCompare(a.session.updatedAt));
  const view = all[0];
  const assigned = Object.values(tasks).filter((task) => task.agentId === agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const taskId = view?.session.taskId;
  const busy = view && isActive(view);
  const linked = taskId ? tasks[taskId] ?? tasks[taskId.replace(/-revision$/, '')] : undefined;
  const task = busy ? linked ?? assigned[0] : assigned[0] ?? linked;
  const lastAt = [view?.session.updatedAt, task?.lastEventAt].filter((value): value is string => !!value).sort().at(-1);
  const stale = busy && lastAt && now - Date.parse(lastAt) > STALE_MS;
  const failed = !busy && task?.state === 'failed';
  const status = stale ? 'Sin señal' : busy ? (view.session.state === 'waiting' ? 'En espera' : 'Trabajando') : failed ? 'Detenido' : 'Libre';
  const role = view?.session.role === 'reviewer' || taskId?.endsWith('-revision') ? 'revisor' : 'autor';
  const action = failed ? task.detail ?? 'La última tarea falló' : busy ? actionText(view.action) : 'Disponible';
  return { status, active: status === 'Trabajando', line: task ? `${task.task.title} · ${role} · ${action}` : action };
}
