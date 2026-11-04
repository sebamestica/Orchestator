import type { Usage } from '../../../shared/index.ts';
import type { FetchFn } from './http.ts';

/** Motivo de fin normalizado entre proveedores. */
export type FinishReason = 'stop' | 'length' | 'content-filter' | 'error' | 'other';

/** Fragmentos que entrega cada driver (Anthropic SDK o AI SDK) al adaptador. */
export type StreamChunk =
  | { type: 'text'; text: string; role: 'assistant' | 'thinking-summary' }
  | { type: 'finish'; usage: Usage; finishReason: FinishReason; rawFinishReason?: string };

export interface StreamRequest {
  model: string;
  /** Encargo ya renderizado (`renderBrief`). */
  prompt: string;
  apiKey: string | undefined;
  baseUrl: string;
  fetch: FetchFn;
  signal: AbortSignal;
  maxRetries: number;
  maxOutputTokens: number | undefined;
}

export interface ModelListRequest {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: FetchFn;
  signal: AbortSignal;
}

/** Suma de entrada: total procesado (incluye lo leído de caché y lo escrito en ella), como en claude-sdk. */
export function compactUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  model?: string | undefined;
}): Usage {
  const int = (n: number) => Math.max(0, Math.round(n));
  const out: Usage = { inputTokens: int(usage.inputTokens), outputTokens: int(usage.outputTokens) };
  if (usage.cachedInputTokens !== undefined) out.cachedInputTokens = int(usage.cachedInputTokens);
  if (usage.reasoningTokens !== undefined) out.reasoningTokens = int(usage.reasoningTokens);
  if (usage.model) out.model = usage.model;
  return out;
}
