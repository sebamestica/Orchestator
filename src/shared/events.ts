import { z } from 'zod';
import { idSchema } from './agents.ts';

const base = {
  sessionId: z.string().min(1),
  agentId: idSchema,
  /** Sesión padre: presente en subagentes (p. ej. mensajes de Claude con parent_tool_use_id). */
  parentSessionId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
};

export const sessionStateSchema = z.enum(['starting', 'running', 'waiting', 'done', 'failed', 'cancelled']);

export const errorCodeSchema = z.enum(['quota_exhausted', 'auth', 'timeout', 'crash', 'invalid_output', 'cancelled', 'unknown']);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  model: z.string().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

/** Evento normalizado que alimenta los paneles en vivo y el registro de consumo. */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('status'), payload: z.strictObject({ state: sessionStateSchema, detail: z.string().optional() }) }),
  z.strictObject({ ...base, type: z.literal('text'), payload: z.strictObject({ text: z.string(), role: z.enum(['assistant', 'thinking-summary']) }) }),
  z.strictObject({ ...base, type: z.literal('tool_call'), payload: z.strictObject({ callId: z.string(), name: z.string(), inputSummary: z.string() }) }),
  z.strictObject({ ...base, type: z.literal('tool_result'), payload: z.strictObject({ callId: z.string(), ok: z.boolean(), summary: z.string() }) }),
  z.strictObject({ ...base, type: z.literal('file_change'), payload: z.strictObject({ path: z.string(), change: z.enum(['add', 'modify', 'delete']) }) }),
  z.strictObject({ ...base, type: z.literal('usage'), payload: usageSchema }),
  z.strictObject({ ...base, type: z.literal('error'), payload: z.strictObject({ code: errorCodeSchema, message: z.string() }) }),
  z.strictObject({ ...base, type: z.literal('done'), payload: z.strictObject({ ok: z.boolean(), summary: z.string().optional() }) }),
  /** Línea que el adaptador no reconoce: se muestra como texto en lugar de fallar. */
  z.strictObject({ ...base, type: z.literal('raw'), payload: z.strictObject({ source: z.string(), line: z.string() }) }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];
