/**
 * Estimación del costo en curso a partir del `usage` de cada mensaje del asistente, para cortar una
 * tarea que supera `budgetUsd` antes del resultado final y registrar lo gastado si se cancela.
 * El costo oficial es el que informa el SDK en `result.total_cost_usd` / `modelUsage[].costUSD`;
 * esto es solo una red de seguridad (además del `maxBudgetUsd` que se pasa al SDK).
 *
 * Precios públicos en USD por millón de tokens (tabla de la skill claude-api, en caché 2026-10-06).
 * Escritura en caché = 1,25 × entrada (TTL 5 min). Tu servidor intermedio puede cobrar distinto.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4-6': price(3, 15),
  'claude-haiku-5-5': price(0.1, 0.5),
  'claude-haiku-4-5': price(1, 5),
};

/** Modelo desconocido: precio de Opus 5 (prudente para un tope de gasto). */
export const FALLBACK_PRICE: ModelPrice = price(5, 25);

export function priceOf(model: string | undefined): ModelPrice {
  if (!model) return FALLBACK_PRICE;
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  // Ids con prefijo de plataforma (`anthropic.claude-…`) o sufijos (`claude-opus-5-5[1m]`).
  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.includes(k));
  return key ? (MODEL_PRICES[key] as ModelPrice) : FALLBACK_PRICE;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function estimateCostUsd(model: string | undefined, usage: TokenUsage): number {
  const p = priceOf(model);
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1e6;
}
