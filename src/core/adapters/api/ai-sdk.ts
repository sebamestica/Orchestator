import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, type LanguageModel, type LanguageModelUsage } from 'ai';
import { z } from 'zod';
import { openRouterKeySchema } from '../../quota/openrouter.ts';
import { InvalidOutputError } from './errors.ts';
import { getJson } from './http.ts';
import type { ApiProvider } from './providers.ts';
import { compactUsage, type FinishReason, type ModelListRequest, type StreamChunk, type StreamRequest } from './types.ts';

/**
 * Driver del AI SDK (`ai` 7) para OpenAI (Responses API), Google (Gemini API), OpenRouter y servidores compatibles
 * con OpenAI (Chat Completions). Clave y URL base siempre explícitas: los paquetes no leen `OPENAI_BASE_URL` ni las
 * claves del entorno del proceso.
 */

export type AiSdkProvider = Exclude<ApiProvider, 'anthropic'>;

export function languageModel(provider: AiSdkProvider, req: StreamRequest): LanguageModel {
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey: req.apiKey ?? '', baseURL: req.baseUrl, fetch: req.fetch }).responses(req.model);
    case 'google':
      return createGoogle({ apiKey: req.apiKey ?? '', baseURL: req.baseUrl, fetch: req.fetch })(req.model);
    case 'openrouter':
    case 'openai-compatible': {
      const settings = { name: provider, baseURL: req.baseUrl, fetch: req.fetch, includeUsage: true };
      return createOpenAICompatible(req.apiKey ? { ...settings, apiKey: req.apiKey } : settings)(req.model);
    }
  }
}

function mapFinishReason(reason: string): FinishReason {
  if (reason === 'stop' || reason === 'length' || reason === 'content-filter' || reason === 'error') return reason;
  return 'other';
}

function usageFrom(usage: LanguageModelUsage, model: string): StreamChunk & { type: 'finish' } {
  return {
    type: 'finish',
    usage: compactUsage({
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
      reasoningTokens: usage.outputTokenDetails.reasoningTokens,
      model,
    }),
    finishReason: 'other',
  };
}

/** Error que el AI SDK entrega como parte `abort` de la transmisión. */
function abortError(reason: string | undefined): Error {
  const err = new Error(reason ? `Transmisión abortada: ${reason}` : 'Transmisión abortada.');
  err.name = 'AbortError';
  return err;
}

export async function* streamAiSdk(provider: AiSdkProvider, req: StreamRequest): AsyncGenerator<StreamChunk> {
  const result = streamText({
    model: languageModel(provider, req),
    prompt: req.prompt,
    maxRetries: req.maxRetries,
    abortSignal: req.signal,
    ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    // Sin herramientas ni conversación que retomar: no hace falta guardar la respuesta en OpenAI.
    ...(provider === 'openai' ? { providerOptions: { openai: { store: false } } } : {}),
    // Los errores se leen como partes `error` de la transmisión; sin esto el SDK los imprime en consola.
    onError: () => undefined,
  });

  let model = req.model;
  for await (const part of result.stream) {
    switch (part.type) {
      case 'text-delta':
        if (part.text) yield { type: 'text', text: part.text, role: 'assistant' };
        break;
      case 'reasoning-delta':
        if (part.text) yield { type: 'text', text: part.text, role: 'thinking-summary' };
        break;
      case 'finish-step':
        if (part.response.modelId) model = part.response.modelId;
        break;
      case 'finish': {
        const chunk = usageFrom(part.totalUsage, model);
        chunk.finishReason = mapFinishReason(part.finishReason);
        if (part.rawFinishReason) chunk.rawFinishReason = part.rawFinishReason;
        yield chunk;
        return;
      }
      case 'error':
        throw part.error;
      case 'abort':
        throw abortError(part.reason);
      default:
        break;
    }
  }
}

// ── Listado de modelos (no gasta tokens) ─────────────────────────────────────────────────────────────────────────

const openAiModelsSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string().min(1) })),
});

const googleModelsSchema = z.looseObject({
  models: z
    .array(
      z.looseObject({
        name: z.string().min(1),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

function bearer(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** `GET {base}/models` (OpenAI, OpenRouter y compatibles). */
export async function listOpenAiStyleModels(req: ModelListRequest): Promise<string[]> {
  const parsed = openAiModelsSchema.safeParse(await getJson(req.fetch, `${req.baseUrl}/models`, bearer(req.apiKey), req.signal));
  if (!parsed.success) throw new InvalidOutputError('Lista de modelos con formato inesperado (se esperaba `data[].id`).');
  return parsed.data.data.map((m) => m.id);
}

/** `GET {base}/models` de la Gemini API: solo los que admiten `generateContent`, sin el prefijo `models/`. */
export async function listGoogleModels(req: ModelListRequest): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) query.set('pageToken', pageToken);
    const headers: Record<string, string> = req.apiKey ? { 'x-goog-api-key': req.apiKey } : {};
    const parsed = googleModelsSchema.safeParse(await getJson(req.fetch, `${req.baseUrl}/models?${query}`, headers, req.signal));
    if (!parsed.success) throw new InvalidOutputError('Lista de modelos de Google con formato inesperado.');
    for (const m of parsed.data.models ?? []) {
      const methods = m.supportedGenerationMethods;
      if (methods && !methods.includes('generateContent')) continue;
      ids.push(m.name.replace(/^models\//, ''));
    }
    pageToken = parsed.data.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

/**
 * `GET {base}/key` de OpenRouter: comprueba la clave (el listado `/models` es público y no la valida).
 * Lanza `HttpError` si la rechaza.
 */
export async function checkOpenRouterKey(req: ModelListRequest): Promise<void> {
  const parsed = openRouterKeySchema.safeParse(await getJson(req.fetch, `${req.baseUrl}/key`, bearer(req.apiKey), req.signal));
  if (!parsed.success) throw new InvalidOutputError('Respuesta de OpenRouter /key con formato inesperado.');
}
