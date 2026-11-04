import { z } from 'zod';
import type { AgentEvent, ErrorCode } from '../../../shared/index.ts';

export type EventBody = AgentEvent extends infer E ? E extends AgentEvent ? Pick<E, 'type' | 'payload'> : never : never;
const envelope = z.object({ type: z.string() });
const itemSchema = z.object({ item: z.object({
  id: z.string(), type: z.string(), text: z.string().optional(), command: z.string().optional(),
  aggregated_output: z.string().optional(), exit_code: z.number().int().nullable().optional(),
  status: z.string().optional(), changes: z.array(z.object({ path: z.string(), kind: z.enum(['add', 'update', 'delete']) })).optional(),
}) });
const usageSchema = z.object({ usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().optional(), reasoning_output_tokens: z.number().int().nonnegative().optional() }) });
const failureSchema = z.object({ message: z.string().optional(), error: z.union([z.string(), z.object({ message: z.string() })]).optional() });

export function classifyCodexError(message: string): ErrorCode {
  if (/usage[_ -]?limit|rate[_ -]?limit|quota|limit[_ -]?(?:reached|exceeded)|too many requests|insufficient_quota/i.test(message)) return 'quota_exhausted';
  if (/unauthorized|authentication|not logged in|login required|401/i.test(message)) return 'auth';
  return 'unknown';
}

/** Los tipos nuevos se conservan como raw; los conocidos malformados fallan explícitamente. */
export function translateCodexEvent(value: unknown, line: string): EventBody[] {
  const raw = (): EventBody[] => [{ type: 'raw', payload: { source: 'codex-cli', line } }];
  const head = envelope.safeParse(value);
  if (!head.success) return [{ type: 'error', payload: { code: 'invalid_output', message: 'Evento Codex sin type válido' } }];
  try {
    switch (head.data.type) {
      case 'thread.started': {
        const event = z.object({ thread_id: z.string() }).parse(value);
        return [{ type: 'status', payload: { state: 'running', detail: event.thread_id } }];
      }
      case 'turn.started': return [{ type: 'status', payload: { state: 'running' } }];
      case 'item.started':
      case 'item.completed': {
        const { item } = itemSchema.parse(value);
        const completed = head.data.type === 'item.completed';
        switch (item.type) {
          case 'agent_message':
          case 'reasoning':
            if (item.type === 'agent_message' && item.text && /you(?:'ve| have) hit your usage limit|usage_limit_reached|insufficient_quota/i.test(item.text)) {
              return [{ type: 'error', payload: { code: 'quota_exhausted', message: item.text } }];
            }
            return item.text === undefined ? raw() : [{ type: 'text', payload: { text: item.text, role: item.type === 'reasoning' ? 'thinking-summary' : 'assistant' } }];
          case 'command_execution':
            return completed
              ? [{ type: 'tool_result', payload: { callId: item.id, ok: item.exit_code === 0 && item.status !== 'failed', summary: item.aggregated_output ?? '' } }]
              : [{ type: 'tool_call', payload: { callId: item.id, name: 'command_execution', inputSummary: item.command ?? '' } }];
          case 'file_change': {
            if (!item.changes) return raw();
            const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join('\n');
            // Codex real emite item.started (in_progress) y luego item.completed para cada parche.
            if (!completed) return [{ type: 'tool_call', payload: { callId: item.id, name: 'file_change', inputSummary: summary } }];
            const ok = item.status !== 'failed';
            const changes: EventBody[] = ok
              ? item.changes.map((change) => ({ type: 'file_change', payload: { path: change.path, change: change.kind === 'update' ? 'modify' : change.kind } }))
              : [];
            return [...changes, { type: 'tool_result', payload: { callId: item.id, ok, summary } }];
          }
          default: return raw();
        }
      }
      case 'turn.completed': {
        const { usage } = usageSchema.parse(value);
        return [{ type: 'usage', payload: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
          ...(usage.cached_input_tokens === undefined ? {} : { cachedInputTokens: usage.cached_input_tokens }),
          ...(usage.reasoning_output_tokens === undefined ? {} : { reasoningTokens: usage.reasoning_output_tokens }) } }];
      }
      case 'error':
      case 'turn.failed': {
        const event = failureSchema.parse(value);
        const message = event.message ?? (typeof event.error === 'string' ? event.error : event.error?.message) ?? 'Codex falló sin detalle';
        return [{ type: 'error', payload: { code: classifyCodexError(message), message } }];
      }
      default: return raw();
    }
  } catch {
    return [{ type: 'error', payload: { code: 'invalid_output', message: `Evento Codex malformado: ${head.data.type}` } }];
  }
}
