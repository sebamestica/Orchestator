import { z } from 'zod';
import { agentEventSchema, sessionStateSchema } from '../../../shared/events.ts';
import type { AgentEvent, SessionRecord } from '../../api/types.ts';

// Espejo del contrato REST: el código del núcleo no entra en la interfaz.
export const sessionsSchema = z.object({ sessions: z.array(z.object({
  id: z.string(), agentId: z.string(), taskId: z.string().nullable(), parentSessionId: z.string().nullable(),
  state: sessionStateSchema, startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(), lastSeq: z.number().int().min(-1),
})) });
export const dailyUsageSchema = z.object({ rows: z.array(z.object({ day: z.string().optional(), costUsd: z.number().nonnegative() })) });
export interface SessionView {
  session: SessionRecord;
  events: AgentEvent[];
  input: number;
  output: number;
  cost: number;
  model?: string;
  cursor: number;
  received: [number, number][];
}
export const initialView = (session: SessionRecord): SessionView => ({ session, events: [], input: 0, output: 0, cost: 0, cursor: -1, received: [] });
export const isActive = (view: SessionView) => ['starting', 'running', 'waiting'].includes(view.session.state);

export function applyEvents(current: Record<string, SessionView>, incoming: unknown[]): Record<string, SessionView> {
  const next = { ...current };
  for (const item of incoming) {
    const parsed = agentEventSchema.safeParse(item);
    if (!parsed.success) continue;
    const event = parsed.data;
    const previous = next[event.sessionId] ?? initialView({ id: event.sessionId, agentId: event.agentId,
      taskId: null, parentSessionId: event.parentSessionId ?? null, state: 'running', startedAt: event.ts,
      updatedAt: event.ts, endedAt: null, lastSeq: -1 });
    if (previous.received.some(([start, end]) => event.seq >= start && event.seq <= end)) continue;
    const received: [number, number][] = [];
    for (const range of [...previous.received, [event.seq, event.seq] as [number, number]].sort((a, b) => a[0] - b[0])) {
      const last = received.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else received.push([...range]);
    }
    const view = { ...previous, session: { ...previous.session, updatedAt: event.ts,
      lastSeq: Math.max(previous.session.lastSeq, event.seq), parentSessionId: event.parentSessionId ?? previous.session.parentSessionId },
      cursor: Math.max(previous.cursor, event.seq), received,
      events: [...previous.events, event].sort((a, b) => a.seq - b.seq).slice(-500) };
    if (event.seq >= previous.session.lastSeq) {
      if (event.type === 'status') view.session.state = event.payload.state;
      if (event.type === 'done') view.session.state = event.payload.ok ? 'done' : 'failed';
    }
    if (event.type === 'usage') {
      view.input += event.payload.inputTokens;
      view.output += event.payload.outputTokens;
      view.cost += event.payload.costUsd ?? 0;
      if (event.payload.model) view.model = event.payload.model;
    }
    next[event.sessionId] = view;
  }
  return next;
}
