import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translateCodexEvent } from '../../../../src/core/adapters/codex-cli/translate.ts';
import { CodexQuotaProvider } from '../../../../src/core/quota/codex.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../../fixtures/codex/${name}`, import.meta.url), 'utf8');

describe('Codex con salidas reales grabadas (2026-11-01, codex-cli 0.165.0)', () => {
  it('traduce una sesión real con comando y edición de archivo', () => {
    const bodies = fixture('exec-command-edit.jsonl').split('\n').filter(Boolean)
      .flatMap((line) => translateCodexEvent(JSON.parse(line), line));
    const types = bodies.map((b) => b.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('file_change');
    expect(types).toContain('usage');
    expect(types).not.toContain('raw');
    const change = bodies.find((b) => b.type === 'file_change');
    expect(change?.payload).toMatchObject({ change: 'modify' });
    // La edición real llega como item.started + item.completed: un tool_call y su tool_result con el mismo callId.
    const patchCall = bodies.find((b) => b.type === 'tool_call' && b.payload.name === 'file_change');
    const patchResult = bodies.find((b) => b.type === 'tool_result' && patchCall?.type === 'tool_call' && b.payload.callId === patchCall.payload.callId);
    expect(patchResult?.payload).toMatchObject({ ok: true });
    expect(JSON.stringify(bodies)).not.toContain('SEBASTIAN');
  });

  it('lee el cupo real del app-server como buckets de 5 h y semanal', async () => {
    const real: unknown = JSON.parse(fixture('app-server-ratelimits.json'));
    const snap = await new CodexQuotaProvider('codex', { readAppServer: async () => real, now: () => new Date('2026-11-01T22:00:00Z') }).read();
    expect(snap.stale).toBe(false);
    const windows = Object.fromEntries(snap.buckets.map((b) => [b.window, b.remainingFraction]));
    expect(windows['5h']).toBeCloseTo(0.99);
    expect(windows['weekly']).toBeCloseTo(0.88);
  });
});
