import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { InvalidOutputError } from './errors.ts';
import type { FetchFn } from './http.ts';
import { compactUsage, type FinishReason, type ModelListRequest, type StreamChunk, type StreamRequest } from './types.ts';

/**
 * Driver de Anthropic con `@anthropic-ai/sdk` (Messages API, transmisión con `messages.stream`).
 * El cliente se construye siempre con clave, URL base y `fetch` explícitos y `authToken: null`, para que el SDK no
 * lea `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` ni perfiles del entorno del proceso.
 */

/** `max_tokens` es obligatorio en la Messages API; 16 000 es seguro en todos los modelos Claude 4.x y posteriores. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000;

interface ClientOptions {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: FetchFn;
  maxRetries: number;
}

function client(opts: ClientOptions): Anthropic {
  if (!opts.apiKey) throw new Error('Falta la clave de Anthropic.');
  return new Anthropic({
    apiKey: opts.apiKey,
    authToken: null,
    baseURL: opts.baseUrl,
    fetch: opts.fetch,
    maxRetries: opts.maxRetries,
    logLevel: 'off',
  });
}

const modelInfoSchema = z.looseObject({ id: z.string().min(1) });

/** `GET /v1/models` con paginación del SDK. No gasta tokens. */
export async function listAnthropicModels(req: ModelListRequest): Promise<string[]> {
  const ids: string[] = [];
  const pages = client({ ...req, maxRetries: 1 }).models.list({ limit: 1000 }, { signal: req.signal });
  for await (const model of pages) {
    const parsed = modelInfoSchema.safeParse(model);
    if (!parsed.success) throw new InvalidOutputError('Lista de modelos de Anthropic con formato inesperado.');
    ids.push(parsed.data.id);
    if (ids.length >= 5000) break;
  }
  return ids;
}

const count = z.number().nonnegative().nullish();

/** Lo que se usa del mensaje final (el SDK no valida la respuesta; un intermediario podría alterarla). */
const finalMessageSchema = z.looseObject({
  model: z.string().nullish(),
  stop_reason: z.string().nullish(),
  usage: z.looseObject({
    input_tokens: count,
    output_tokens: count,
    cache_read_input_tokens: count,
    cache_creation_input_tokens: count,
    output_tokens_details: z.looseObject({ thinking_tokens: count }).nullish(),
  }),
});

export function mapAnthropicStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'content-filter';
    default:
      return 'other';
  }
}

export async function* streamAnthropic(req: StreamRequest): AsyncGenerator<StreamChunk> {
  const stream = client(req).messages.stream(
    {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: [{ role: 'user', content: req.prompt }],
    },
    { signal: req.signal },
  );

  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type === 'text_delta' && event.delta.text) {
      yield { type: 'text', text: event.delta.text, role: 'assistant' };
    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      // Solo llega texto si el modelo devuelve resúmenes de razonamiento (`display: "summarized"`).
      yield { type: 'text', text: event.delta.thinking, role: 'thinking-summary' };
    }
  }

  const parsed = finalMessageSchema.safeParse(await stream.finalMessage());
  if (!parsed.success) throw new InvalidOutputError('Mensaje final de Anthropic sin `usage` válido.');
  const { usage, model, stop_reason: stopReason } = parsed.data;
  const cacheRead = usage.cache_read_input_tokens ?? undefined;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const chunk: StreamChunk = {
    type: 'finish',
    usage: compactUsage({
      inputTokens: (usage.input_tokens ?? 0) + (cacheRead ?? 0) + cacheWrite,
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens: cacheRead,
      reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? undefined,
      model: model ?? req.model,
    }),
    finishReason: mapAnthropicStopReason(stopReason),
  };
  if (stopReason) chunk.rawFinishReason = stopReason;
  yield chunk;
}
