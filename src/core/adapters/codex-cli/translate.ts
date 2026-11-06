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
  cached_input_tokens: z.number().int().nonnegative().optional(), cache_write_input_tokens: z.number().int().nonnegative().optional(),
  reasoning_output_tokens: z.number().int().nonnegative().optional() }) });
const failureSchema = z.object({ message: z.string().optional(), error: z.union([z.string(), z.object({ message: z.string() })]).optional() });

export function classifyCodexError(message: string): ErrorCode {
  if (/usage[_ -]?limit|rate[_ -]?limit|quota|limit[_ -]?(?:reached|exceeded)|too many requests|insufficient_quota/i.test(message)) return 'quota_exhausted';
  // `\b401\b`: un 401 dentro de un nombre al azar (codex-arg0a4012b) no es falta de sesión.
  if (/unauthorized|authentication|not logged in|login required|\b401\b/i.test(message)) return 'auth';
  return 'unknown';
}

/**
 * Línea suelta (stderr o stdout no JSON) que Codex marca como error: `Error: …` (salida del proceso) o `ERROR …`,
 * solo o tras la marca de tiempo del log. Los avisos `WARNING:` y el resto del diagnóstico no deciden el resultado.
 */
export function isCodexErrorLine(line: string): boolean {
  return /^\s*(?:\d{4}-\d\d-\d\dT\S+\s+)?(?:Error:|ERROR\b)/.test(line);
}

export interface CodexTranslateOptions {
  /**
   * Modelo con el que se lanzó Codex (`-m`, el `model` del agente). `codex exec --json` no lo informa en ningún
   * evento: sin él, el uso queda sin modelo.
   */
  model?: string;
}

/** Los tipos nuevos se conservan como raw; los conocidos malformados fallan explícitamente. */
export function translateCodexEvent(value: unknown, line: string, opts: CodexTranslateOptions = {}): EventBody[] {
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
            // Texto libre del modelo: puede citar «insufficient_quota» sin que falte cupo. El cupo real llega por `error`/`turn.failed`.
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
        // `input_tokens` ya es la entrada total (con lo leído y lo escrito en caché): la convención normalizada.
        const { usage } = usageSchema.parse(value);
        return [{ type: 'usage', payload: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
          ...(usage.cached_input_tokens === undefined ? {} : { cachedInputTokens: usage.cached_input_tokens }),
          cacheWriteTokens: usage.cache_write_input_tokens ?? 0,
          ...(usage.reasoning_output_tokens === undefined ? {} : { reasoningTokens: usage.reasoning_output_tokens }),
          ...(opts.model ? { model: opts.model } : {}) } }];
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
