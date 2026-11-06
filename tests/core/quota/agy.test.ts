import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { minRemainingFraction, quotaSnapshotSchema } from '../../../src/shared/index.ts';
import { AgyQuotaProvider, parseAgyUsage, resolveAgyCommand } from '../../../src/core/quota/agy.ts';

describe('AgyQuotaProvider / parseAgyUsage', () => {
  const usageFixturePath = path.resolve(__dirname, '../../../fixtures/agy/usage.json');
  const usageRaw = JSON.parse(readFileSync(usageFixturePath, 'utf8'));

  it('parsea correctamente la fixture usage.json real', () => {
    const snap = parseAgyUsage(usageRaw, 'agy', '2026-11-01T20:00:00Z');
    expect(quotaSnapshotSchema.parse(snap)).toBeDefined();

    expect(snap.agentId).toBe('agy');
    expect(snap.method).toBe('agy-usage');
    expect(snap.stale).toBe(false);
    expect(snap.buckets).toHaveLength(4);

    const geminiWeekly = snap.buckets.find((b) => b.groupId === 'gemini-models' && b.window === 'weekly');
    expect(geminiWeekly).toBeDefined();
    expect(geminiWeekly?.groupName).toBe('Gemini Models');
    expect(geminiWeekly?.remainingFraction).toBeCloseTo(0.9996, 3);
    expect(geminiWeekly?.resetAt).toBe('2026-11-08T19:45:40Z');

    const gemini5h = snap.buckets.find((b) => b.groupId === 'gemini-models' && b.window === '5h');
    expect(gemini5h).toBeDefined();
    expect(gemini5h?.remainingFraction).toBeCloseTo(0.9986, 3);
    expect(gemini5h?.resetAt).toBe('2026-11-02T00:45:40Z');

    const thirdPartyWeekly = snap.buckets.find((b) => b.groupId === 'claude-and-gpt-models' && b.window === 'weekly');
    expect(thirdPartyWeekly).toBeDefined();
    expect(thirdPartyWeekly?.remainingFraction).toBe(1);

    expect(minRemainingFraction(snap)).toBeCloseTo(0.9986, 3);
  });

  describe('con el modelo del agente, decide solo con el grupo que ese modelo gasta', () => {
    // Copia en memoria: grupo Claude/GPT casi agotado y Gemini entero.
    const spent = structuredClone(usageRaw) as { command: { data: { groups: { name: string; buckets: { remaining_fraction: number }[] }[] } } };
    for (const group of spent.command.data.groups) {
      for (const bucket of group.buckets) bucket.remaining_fraction = group.name === 'Gemini Models' ? 1 : 0.02;
    }

    it('modelo Gemini → 1, aunque Claude/GPT esté al 2 %', () => {
      const snap = parseAgyUsage(spent, 'agy', '2026-11-01T20:00:00Z', { model: 'gemini-3.8-flash-high' });
      expect(minRemainingFraction(snap)).toBe(1);
      expect(snap.buckets).toHaveLength(4); // la interfaz sigue viendo los dos grupos
      expect(snap.buckets.filter((b) => b.inUse).map((b) => b.groupId)).toEqual(['gemini-models', 'gemini-models']);
    });

    it('modelo Claude → 0,02', () => {
      const snap = parseAgyUsage(spent, 'agy', '2026-11-01T20:00:00Z', { model: 'claude-sonnet-4-6' });
      expect(minRemainingFraction(snap)).toBe(0.02);
      expect(snap.buckets.filter((b) => b.inUse).map((b) => b.groupId)).toEqual(['claude-and-gpt-models', 'claude-and-gpt-models']);
    });

    it('sin modelo o con uno que no encaja en ningún grupo → todos los grupos, como antes', () => {
      expect(minRemainingFraction(parseAgyUsage(spent, 'agy', '2026-11-01T20:00:00Z'))).toBe(0.02);
      const unknown = parseAgyUsage(spent, 'agy', '2026-11-01T20:00:00Z', { model: 'llama-4' });
      expect(minRemainingFraction(unknown)).toBe(0.02);
      expect(unknown.buckets.some((b) => b.inUse)).toBe(false);
    });
  });

  it('falla con un objeto que no cumple el esquema de agy usage', () => {
    expect(() => parseAgyUsage({ command: { name: 'other' } }, 'agy')).toThrow();
  });

  it('resuelve el comando según plataforma y opciones', () => {
    expect(resolveAgyCommand('custom-agy')).toBe('custom-agy');
  });

  it('devuelve snapshot con stale=true y error si el proceso falla sin JSON', async () => {
    const provider = new AgyQuotaProvider({
      agentId: 'agy',
      command: process.execPath,
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    // Invocando node sin argumentos fallará o saldrá inmediatamente sin json de agy
    const snap = await provider.read();
    expect(snap.stale).toBe(true);
    expect(snap.error).toBeDefined();
    expect(snap.buckets).toHaveLength(0);
  });
});
