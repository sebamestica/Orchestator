import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../../../src/core/adapters/claude-sdk/pricing.ts';
import { usageDeltas } from '../../../src/core/conductor/usage.ts';
import type { AgentEvent } from '../../../src/shared/index.ts';

function usage(payload: Extract<AgentEvent, { type: 'usage' }>['payload']): AgentEvent {
  return { sessionId: 's1', agentId: 'orquestador', seq: 0, ts: '2026-11-04T00:00:00.000Z', type: 'usage', payload };
}

describe('usageDeltas: los acumulados del SDK se guardan como diferencias', () => {
  it('también resta la caché escrita y el razonamiento (antes se copiaban acumulados)', () => {
    const delta = usageDeltas();
    delta(usage({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 600, cacheWriteTokens: 300, reasoningTokens: 40, costUsd: 0.1, model: 'm' }));
    const second = delta(usage({ inputTokens: 2500, outputTokens: 180, cachedInputTokens: 1800, cacheWriteTokens: 500, reasoningTokens: 70, costUsd: 0.25, model: 'm' }));
    expect(second?.type === 'usage' ? second.payload : undefined).toEqual({
      inputTokens: 1500,
      outputTokens: 80,
      cachedInputTokens: 1200,
      cacheWriteTokens: 200,
      reasoningTokens: 30,
      costUsd: 0.15,
      model: 'm',
    });
  });

  it('proceso reanudado: la primera diferencia de cada modelo es solo el uso propio del proceso (issue uso-real-02)', () => {
    const cost = (input: number, output: number) => estimateCostUsd('m', { input, output, cacheRead: 0, cacheWrite: 0 });
    const delta = usageDeltas({ own: () => ({ m: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: cost(50, 5) } }) });
    const payload = (e: AgentEvent | undefined) => (e?.type === 'usage' ? e.payload : undefined);
    // El SDK reanudado trae 100/10 restaurados + 50/5 propios.
    const first = payload(delta(usage({ inputTokens: 150, outputTokens: 15, costUsd: cost(150, 15), model: 'm' })));
    expect(first).toMatchObject({ inputTokens: 50, outputTokens: 5, model: 'm' });
    expect(first?.costUsd).toBeCloseTo(cost(50, 5), 9);
    // Desde ahí, diferencias contra el acumulado anterior, como siempre.
    const second = payload(delta(usage({ inputTokens: 200, outputTokens: 20, costUsd: cost(200, 20), model: 'm' })));
    expect(second).toMatchObject({ inputTokens: 50, outputTokens: 5 });
    expect(second?.costUsd).toBeCloseTo(cost(50, 5), 9);
    // Un modelo restaurado que este proceso no usó no deja fila.
    expect(delta(usage({ inputTokens: 900, outputTokens: 90, costUsd: 0.5, model: 'otro' }))).toBeUndefined();
  });
});
