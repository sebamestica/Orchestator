import type { AgentEvent } from '../../shared/index.ts';

/**
 * `modelUsage` y `total_cost_usd` del SDK son acumulados en una conversación con entrada en streaming (cada `result`
 * trae el total hasta ahora). Para no sumarlos dos veces en SQLite, cada evento `usage` se guarda como diferencia.
 * Un proceso del SDK nuevo (sesión reanudada) vuelve a contar desde cero: usa una función nueva por proceso.
 */
export function usageDeltas(): (event: AgentEvent) => AgentEvent | undefined {
  const prev = new Map<string, { input: number; output: number; cached: number; cost: number }>();
  return (event) => {
    if (event.type !== 'usage') return event;
    const u = event.payload;
    const key = `${event.sessionId}\u0000${u.model ?? ''}`;
    const before = prev.get(key) ?? { input: 0, output: 0, cached: 0, cost: 0 };
    const now = { input: u.inputTokens, output: u.outputTokens, cached: u.cachedInputTokens ?? 0, cost: u.costUsd ?? 0 };
    prev.set(key, now);
    const d = (a: number, b: number) => Math.max(0, a - b);
    if (d(now.input, before.input) + d(now.output, before.output) === 0 && d(now.cost, before.cost) === 0) return undefined;
    return {
      ...event,
      payload: {
        ...u,
        inputTokens: d(now.input, before.input),
        outputTokens: d(now.output, before.output),
        ...(u.cachedInputTokens !== undefined ? { cachedInputTokens: d(now.cached, before.cached) } : {}),
        ...(u.costUsd !== undefined ? { costUsd: Math.round(d(now.cost, before.cost) * 1e9) / 1e9 } : {}),
      },
    };
  };
}
