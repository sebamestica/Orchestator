import { z } from 'zod';
import type { AgentEvent, ErrorCode, Usage } from '../../../shared/index.ts';

export type EventBody = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Pick<E, 'type' | 'payload'>
    : never
  : never;

const agyEnvelopeSchema = z.object({
  event: z.string(),
  conversation_id: z.string().optional(),
});

const agyInitSchema = z.object({
  event: z.literal('init'),
  conversation_id: z.string().optional(),
  init: z
    .object({
      model: z.string().optional(),
      cwd: z.string().optional(),
      tools: z.array(z.string()).optional(),
      permission_mode: z.string().optional(),
    })
    .optional(),
});

const agyUsageRawSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  thinking_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
});

const agyStepUpdateSchema = z.object({
  event: z.literal('step_update'),
  step_update: z.object({
    conversation_id: z.string().optional(),
    step_index: z.number().int().nonnegative(),
    state: z.string(),
    step_type: z.string(),
    duration_seconds: z.number().optional(),
    text_delta: z.string().optional(),
    tool_name: z.string().optional(),
    tool_info: z
      .object({
        name: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        output: z.string().optional(),
        error: z.unknown().optional(),
      })
      .optional(),
    usage: agyUsageRawSchema.optional(),
  }),
});

const agyResultSchema = z.object({
  event: z.literal('result'),
  result: z.object({
    conversation_id: z.string().optional(),
    status: z.string(),
    response: z.string().optional(),
    error: z.string().optional(),
    duration_seconds: z.number().optional(),
    num_turns: z.number().optional(),
    usage: agyUsageRawSchema.optional(),
    finished_reason: z.string().optional(),
  }),
});

/** Clasifica mensajes de error del CLI de agy hacia los códigos normalizados de ErrorCode. */
export function classifyAgyError(message: string): ErrorCode {
  if (
    /RESOURCE_EXHAUSTED|rate[_ -]?limit|quota|limit[_ -]?(?:reached|exceeded)|too many requests|insufficient_quota/i.test(
      message,
    )
  ) {
    return 'quota_exhausted';
  }
  if (/unauthorized|authentication|not logged in|login required|401|api[ _-]?key/i.test(message)) {
    return 'auth';
  }
  if (/timed?[ _-]?out|timeout/i.test(message)) {
    return 'timeout';
  }
  if (/cancelled|abort/i.test(message)) {
    return 'cancelled';
  }
  if (/invalid model|model .* not recognized/i.test(message)) {
    return 'invalid_output';
  }
  return 'unknown';
}

function summarizeToolInput(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const obj = params as Record<string, unknown>;
  if (typeof obj.CommandLine === 'string') return obj.CommandLine;
  if (typeof obj.command === 'string') return obj.command;
  if (typeof obj.Path === 'string') return obj.Path;
  if (typeof obj.path === 'string') return obj.path;
  return JSON.stringify(params);
}

/**
 * Uso de un paso en la convención normalizada (`usageSchema`): agy informa `input_tokens` SIN la caché leída
 * (en los datos reales `cache_read_tokens` supera a menudo a `input_tokens`), así que la entrada total es la suma.
 * agy no informa escritura en caché: va en 0.
 */
function mapUsage(raw: z.infer<typeof agyUsageRawSchema>, model: string | undefined): Usage {
  const cacheRead = raw.cache_read_tokens ?? 0;
  return {
    inputTokens: raw.input_tokens + cacheRead,
    outputTokens: raw.output_tokens,
    cachedInputTokens: cacheRead,
    cacheWriteTokens: 0,
    ...(typeof raw.thinking_tokens === 'number'
      ? { reasoningTokens: raw.thinking_tokens }
      : {}),
    ...(model ? { model } : {}),
  };
}

export interface AgyTranslateOptions {
  /** Modelo con el que se lanzó agy (`--model`): se usa si el `init` de la conversación no lo trae. */
  model?: string;
}

/** Conversaciones recordadas a la vez (cada ejecución de agy es una; se olvida al llegar su `result`). */
const MAX_CONVERSATIONS = 64;
/**
 * Modelo de cada conversación en curso (`conversation_id` → `init.model`), para anotarlo en el uso de sus pasos:
 * los `step_update` no lo repiten y la traducción es por línea.
 */
const conversationModels = new Map<string, string>();

function rememberModel(conversationId: string | undefined, model: string | undefined): void {
  if (!conversationId || !model) return;
  conversationModels.delete(conversationId);
  conversationModels.set(conversationId, model);
  while (conversationModels.size > MAX_CONVERSATIONS) {
    const oldest = conversationModels.keys().next().value;
    if (oldest === undefined) break;
    conversationModels.delete(oldest);
  }
}

function modelOf(conversationId: string | undefined, opts: AgyTranslateOptions): string | undefined {
  return (conversationId ? conversationModels.get(conversationId) : undefined) ?? opts.model;
}

/**
 * Traduce una línea JSON del stream de agy CLI (`--output-format stream-json`)
 * a uno o más fragmentos de AgentEvent (`EventBody`).
 */
export function translateAgyEvent(value: unknown, line: string, opts: AgyTranslateOptions = {}): EventBody[] {
  const envelope = agyEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return [
      {
        type: 'error',
        payload: {
          code: 'invalid_output',
          message: 'Línea de stream sin estructura esperada de agy',
        },
      },
    ];
  }

  try {
    switch (envelope.data.event) {
      case 'init': {
        const init = agyInitSchema.parse(value);
        rememberModel(init.conversation_id, init.init?.model);
        const detail = init.conversation_id ?? init.init?.model;
        return [
          {
            type: 'status',
            payload: {
              state: 'running',
              ...(detail ? { detail } : {}),
            },
          },
        ];
      }

      case 'step_update': {
        const parsed = agyStepUpdateSchema.parse(value);
        const step = parsed.step_update;
        const model = modelOf(step.conversation_id ?? envelope.data.conversation_id, opts);
        const events: EventBody[] = [];

        switch (step.step_type) {
          case 'agent_response': {
            if (step.text_delta && step.text_delta.length > 0) {
              events.push({
                type: 'text',
                payload: {
                  text: step.text_delta,
                  role: 'assistant',
                },
              });
            }
            if (step.usage) {
              events.push({
                type: 'usage',
                payload: mapUsage(step.usage, model),
              });
            }
            return events;
          }

          case 'tool': {
            const callId = String(step.step_index);
            const toolName = step.tool_name ?? step.tool_info?.name ?? 'unknown_tool';

            if (step.state === 'ACTIVE') {
              events.push({
                type: 'tool_call',
                payload: {
                  callId,
                  name: toolName,
                  inputSummary: summarizeToolInput(step.tool_info?.parameters),
                },
              });
            } else if (step.state === 'DONE') {
              const isFileTool = [
                'write_file',
                'write_to_file',
                'replace_file_content',
                'multi_replace_file_content',
                'edit_file',
                'sed_file',
              ].includes(toolName);
              const params = step.tool_info?.parameters;
              const targetPath =
                typeof params?.Path === 'string'
                  ? params.Path
                  : typeof params?.path === 'string'
                    ? params.path
                    : undefined;
              const hasError = Boolean(step.tool_info?.error);

              if (isFileTool && targetPath && !hasError) {
                events.push({
                  type: 'file_change',
                  payload: {
                    path: targetPath,
                    change: 'modify',
                  },
                });
              }

              events.push({
                type: 'tool_result',
                payload: {
                  callId,
                  ok: !hasError,
                  summary:
                    step.tool_info?.output ??
                    (hasError ? String(step.tool_info?.error) : `${toolName} completado`),
                },
              });
            }

            if (step.usage) {
              events.push({
                type: 'usage',
                payload: mapUsage(step.usage, model),
              });
            }
            return events;
          }

          case 'user_input': {
            if (step.usage) {
              return [{ type: 'usage', payload: mapUsage(step.usage, model) }];
            }
            return [];
          }

          default: {
            return [{ type: 'raw', payload: { source: 'agy-cli', line } }];
          }
        }
      }

      case 'result': {
        const parsed = agyResultSchema.parse(value);
        const res = parsed.result;
        const conversationId = res.conversation_id ?? envelope.data.conversation_id;
        if (conversationId) conversationModels.delete(conversationId);

        if (res.status === 'ERROR' || res.error) {
          const message = res.error || 'agy falló con estado ERROR';
          return [
            {
              type: 'error',
              payload: {
                code: classifyAgyError(message),
                message,
              },
            },
          ];
        }

        if (res.status === 'SUCCESS') {
          return [
            {
              type: 'done',
              payload: {
                ok: true,
                ...(res.response ? { summary: res.response } : {}),
              },
            },
          ];
        }

        return [
          {
            type: 'done',
            payload: {
              ok: false,
              summary: `agy finalizó con estado inesperado: ${res.status}`,
            },
          },
        ];
      }

      default: {
        return [{ type: 'raw', payload: { source: 'agy-cli', line } }];
      }
    }
  } catch (err) {
    return [
      {
        type: 'error',
        payload: {
          code: 'invalid_output',
          message: `Evento agy malformado (${envelope.data.event}): ${err instanceof Error ? err.message : String(err)}`,
        },
      },
    ];
  }
}
