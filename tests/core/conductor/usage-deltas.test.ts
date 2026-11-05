import { describe, expect, it } from 'vitest';
import { usageDeltas } from '../../../src/core/conductor/usage.ts';
import type { AgentEvent } from '../../../src/shared/index.ts';

function usage(payload: Extract<AgentEvent, { type: 'usage' }>['payload']): AgentEvent {
  return { id: crypto.randomUUID(), sessionId: 's1', ts: '2026-11-04T00:00:00.000Z', type: 'usage', payload } as AgentEvent;
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
});
