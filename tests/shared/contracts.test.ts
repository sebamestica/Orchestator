import { describe, expect, it } from 'vitest';
import { agentEventSchema, minRemainingFraction, quotaSnapshotSchema, redactSecrets, REDACTED, taskBriefSchema } from '../../src/shared/index.ts';

describe('contratos compartidos', () => {
  it('acepta un evento de subagente y rechaza campos desconocidos', () => {
    const ev = { sessionId: 's1', agentId: 'claude-1', parentSessionId: 'p1', seq: 0, ts: '2026-11-01T12:00:00Z', type: 'text', payload: { text: 'hola', role: 'assistant' } };
    expect(agentEventSchema.parse(ev).type).toBe('text');
    expect(() => agentEventSchema.parse({ ...ev, extra: 1 })).toThrow();
  });

  it('exige rutas propias y criterios de aceptación en cada encargo', () => {
    const brief = { id: 't1', projectId: 'vetworld', title: 'x', objective: 'y', ownedPaths: [], dependsOn: [], acceptance: ['z'], difficulty: 'low' };
    expect(() => taskBriefSchema.parse(brief)).toThrow();
    expect(taskBriefSchema.parse({ ...brief, ownedPaths: ['src/a.ts'] }).contextRefs).toEqual([]);
  });

  it('toma el bucket de cupo más bajo', () => {
    const snap = quotaSnapshotSchema.parse({
      agentId: 'agy', method: 'agy-usage', takenAt: '2026-11-01T12:00:00Z', stale: false,
      buckets: [
        { groupId: 'g', groupName: 'Gemini', window: 'weekly', remainingFraction: 0.9 },
        { groupId: 'g', groupName: 'Gemini', window: '5h', remainingFraction: 0.15 },
        { groupId: 'u', groupName: 'USD', window: 'total', remainingFraction: null, remainingUnits: { amount: 3, unit: 'usd' } },
      ],
    });
    expect(minRemainingFraction(snap)).toBe(0.15);
  });
});

describe('redactSecrets', () => {
  it('tacha claves conocidas y secretos explícitos', () => {
    const text = 'x-api-key: sk-ant-api03-abcdefghijklmnop y google AIzaSyA1234567890abcdefghijklmnopqrstu y mi-secreto-largo';
    const out = redactSecrets(text, ['mi-secreto-largo']);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('AIzaSy');
    expect(out).not.toContain('mi-secreto-largo');
    expect(out).toContain(REDACTED);
  });
});

describe('redactSecrets: límites de palabra (hallazgo de c2)', () => {
  it('no tacha ids legítimos que contienen «sk-» o «gh» dentro de una palabra', () => {
    const ids = 'task-scheduler-with-priorities desk-organizer-component-for-ui weighp_abcdefghijklmnopqrstuvwxyz0123456789';
    expect(redactSecrets(ids)).toBe(ids);
  });
  it('sigue tachando claves reales al inicio, tras espacio, comillas, = o dos puntos', () => {
    const key = `sk-ant-api03-${'a'.repeat(40)}`;
    for (const text of [key, `clave ${key}`, `"${key}"`, `KEY=${key}`, `x:${key}`, `(${key})`]) {
      expect(redactSecrets(text)).not.toContain(key);
    }
    expect(redactSecrets(`OPENAI=sk-proj-${'b'.repeat(30)}`)).toBe(`OPENAI=${REDACTED}`);
  });
});

describe('redactSecrets: patrón genérico tras «authorization», «bearer» o «apikey»', () => {
  it('no tacha palabras ni rutas pegadas a la palabra clave, sin separador', () => {
    for (const text of [
      'C:\\dev\\authorization-service-backend',
      'C:\\dev\\authorization-service-backend\\app',
      'ApiKeyManagementService',
      'bearer-token-validation-lib',
      'src/auth/authorization/token-validator.ts',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
  it('sigue tachando el valor tras dos puntos, igual, comillas o espacio', () => {
    const v = 'Ab1-cD2.eF3_gH4~iJ5+kL6/';
    for (const text of [
      `Authorization: Bearer ${v}`,
      `Authorization:Bearer ${v}`,
      `api_key = "${v}"`,
      `{"apiKey":"${v}"}`,
      `{"openaiApiKey":"${v}"}`,
      `anthropicApiKey: ${v}`,
      `x-api-key: ${v}`,
      `Bearer ${v}`,
      `--api-key ${v}`,
      `authorization=${v}`,
      `OPENAI_API_KEY=${v}`,
    ]) {
      const out = redactSecrets(text);
      expect(out, text).not.toContain(v);
      expect(out, text).toContain(REDACTED);
    }
  });
});
