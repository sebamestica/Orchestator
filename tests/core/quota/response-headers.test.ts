import { describe, expect, it } from 'vitest';
import {
  ResponseHeadersQuota,
  hasRateLimitHeaders,
  parseDurationMs,
  parseRateLimitHeaders,
  parseResetAt,
} from '../../../src/core/quota/response-headers.ts';
import { quotaSnapshotSchema } from '../../../src/shared/index.ts';

const at = new Date('2026-11-01T12:00:00.000Z');

/** Cabeceras con los nombres y formatos documentados por Anthropic (docs «Rate limits», respuesta de /v1/messages). */
const ANTHROPIC = new Headers({
  'anthropic-ratelimit-requests-limit': '50',
  'anthropic-ratelimit-requests-remaining': '49',
  'anthropic-ratelimit-requests-reset': '2026-11-01T12:00:01Z',
  'anthropic-ratelimit-tokens-limit': '90000',
  'anthropic-ratelimit-tokens-remaining': '45000',
  'anthropic-ratelimit-tokens-reset': '2026-11-01T12:00:30Z',
  'anthropic-ratelimit-input-tokens-limit': '80000',
  'anthropic-ratelimit-input-tokens-remaining': '79000',
  'anthropic-ratelimit-input-tokens-reset': '2026-11-01T12:00:02Z',
  'anthropic-ratelimit-output-tokens-limit': '10000',
  'anthropic-ratelimit-output-tokens-remaining': '0',
  'anthropic-ratelimit-output-tokens-reset': '2026-11-01T12:00:45Z',
  'anthropic-priority-input-tokens-limit': '1000',
  'anthropic-priority-input-tokens-remaining': '500',
  'retry-after': '45',
  'content-type': 'application/json',
});

/** Cabeceras de OpenAI (docs «Rate limits»: reinicio como duración). */
const OPENAI = {
  'x-ratelimit-limit-requests': '60',
  'x-ratelimit-limit-tokens': '150000',
  'x-ratelimit-remaining-requests': '59',
  'x-ratelimit-remaining-tokens': '149984',
  'x-ratelimit-reset-requests': '1s',
  'x-ratelimit-reset-tokens': '6m0s',
};

/** Cabeceras de OpenRouter y similares: sin sufijo, reinicio como época en ms. */
const OPENROUTER = {
  'X-RateLimit-Limit': '20',
  'X-RateLimit-Remaining': '5',
  'X-RateLimit-Reset': String(Date.parse('2026-11-01T12:01:00.000Z')),
};

describe('parseRateLimitHeaders', () => {
  it('convierte las cabeceras anthropic-ratelimit-* en un bucket por recurso', () => {
    const buckets = parseRateLimitHeaders(ANTHROPIC, at);
    expect(buckets.map((b) => b.groupId)).toEqual(['input-tokens', 'output-tokens', 'priority-input-tokens', 'requests', 'tokens']);
    expect(buckets.find((b) => b.groupId === 'requests')).toEqual({
      groupId: 'requests',
      groupName: 'Solicitudes',
      window: 'custom',
      remainingFraction: 0.98,
      remainingUnits: { amount: 49, unit: 'requests' },
      resetAt: '2026-11-01T12:00:01.000Z',
    });
    expect(buckets.find((b) => b.groupId === 'output-tokens')).toMatchObject({
      groupName: 'Tokens de salida',
      remainingFraction: 0,
      remainingUnits: { amount: 0, unit: 'tokens' },
      resetAt: '2026-11-01T12:00:45.000Z',
    });
    expect(buckets.find((b) => b.groupId === 'priority-input-tokens')).toMatchObject({ groupName: 'Tokens de entrada (prioridad)', remainingFraction: 0.5 });
  });

  it('entiende el formato x-ratelimit-* de OpenAI con duraciones relativas', () => {
    const buckets = parseRateLimitHeaders(OPENAI, at);
    expect(buckets).toEqual([
      {
        groupId: 'requests',
        groupName: 'Solicitudes',
        window: 'custom',
        remainingFraction: 59 / 60,
        remainingUnits: { amount: 59, unit: 'requests' },
        resetAt: '2026-11-01T12:00:01.000Z',
      },
      {
        groupId: 'tokens',
        groupName: 'Tokens',
        window: 'custom',
        remainingFraction: 149984 / 150000,
        remainingUnits: { amount: 149984, unit: 'tokens' },
        resetAt: '2026-11-01T12:06:00.000Z',
      },
    ]);
  });

  it('entiende x-ratelimit-{limit,remaining,reset} sin sufijo (OpenRouter) sin importar mayúsculas', () => {
    expect(parseRateLimitHeaders(OPENROUTER, at)).toEqual([
      {
        groupId: 'requests',
        groupName: 'Solicitudes',
        window: 'custom',
        remainingFraction: 0.25,
        remainingUnits: { amount: 5, unit: 'requests' },
        resetAt: '2026-11-01T12:01:00.000Z',
      },
    ]);
  });

  it('da por repuesto un bucket cuyo reinicio ya pasó', () => {
    const later = new Date('2026-11-01T12:10:00.000Z');
    const output = parseRateLimitHeaders(ANTHROPIC, at, later).find((b) => b.groupId === 'output-tokens');
    expect(output).toEqual({ groupId: 'output-tokens', groupName: 'Tokens de salida', window: 'custom', remainingFraction: 1, remainingUnits: { amount: 10000, unit: 'tokens' } });
  });

  it('ignora cabeceras ajenas o con números inválidos', () => {
    expect(parseRateLimitHeaders({ 'content-type': 'text/plain', 'x-request-id': 'abc' }, at)).toEqual([]);
    expect(parseRateLimitHeaders({ 'x-ratelimit-remaining-requests': 'muchas', 'x-ratelimit-limit-requests': '10' }, at)).toEqual([
      { groupId: 'requests', groupName: 'Solicitudes', window: 'custom', remainingFraction: null },
    ]);
    expect(parseRateLimitHeaders({ 'x-ratelimit-reset-requests': '1s' }, at)).toEqual([]);
  });

  it('acepta valores en arreglo (cabeceras de node:http)', () => {
    const buckets = parseRateLimitHeaders({ 'x-ratelimit-limit': ['10'], 'x-ratelimit-remaining': ['2'], 'x-other': undefined }, at);
    expect(buckets[0]).toMatchObject({ remainingFraction: 0.2 });
  });
});

describe('hasRateLimitHeaders', () => {
  it('detecta si una respuesta trae límites', () => {
    expect(hasRateLimitHeaders(ANTHROPIC)).toBe(true);
    expect(hasRateLimitHeaders(OPENAI)).toBe(true);
    expect(hasRateLimitHeaders(OPENROUTER)).toBe(true);
    expect(hasRateLimitHeaders(new Headers({ 'content-type': 'application/json', 'retry-after': '3' }))).toBe(false);
  });
});

describe('parseDurationMs y parseResetAt', () => {
  it('lee duraciones al estilo Go', () => {
    expect(parseDurationMs('1s')).toBe(1000);
    expect(parseDurationMs('6m0s')).toBe(360_000);
    expect(parseDurationMs('1h2m3.5s')).toBe(3_723_500);
    expect(parseDurationMs('250ms')).toBe(250);
    expect(parseDurationMs('')).toBeUndefined();
    expect(parseDurationMs('6 minutos')).toBeUndefined();
  });

  it('lee RFC 3339, duraciones, épocas en ms o s y segundos relativos', () => {
    expect(parseResetAt('2026-11-01T12:00:30Z', at)).toBe('2026-11-01T12:00:30.000Z');
    expect(parseResetAt('20s', at)).toBe('2026-11-01T12:00:20.000Z');
    expect(parseResetAt(String(Date.parse('2026-11-01T13:00:00Z')), at)).toBe('2026-11-01T13:00:00.000Z');
    expect(parseResetAt(String(Date.parse('2026-11-01T13:00:00Z') / 1000), at)).toBe('2026-11-01T13:00:00.000Z');
    expect(parseResetAt('30', at)).toBe('2026-11-01T12:00:30.000Z');
    expect(parseResetAt('pronto', at)).toBeUndefined();
  });
});

describe('ResponseHeadersQuota', () => {
  it('sin respuestas todavía devuelve una lectura antigua sin buckets', async () => {
    const quota = new ResponseHeadersQuota({ agentId: 'openai-main', now: () => at });
    const snap = quotaSnapshotSchema.parse(await quota.read());
    expect(snap).toMatchObject({ method: 'response-headers', stale: true, buckets: [] });
    expect(snap.error).toMatch(/Aún no hay respuestas/);
  });

  it('guarda solo respuestas con límites y marca stale tras 10 min', async () => {
    let clock = at;
    const quota = new ResponseHeadersQuota({ agentId: 'openai-main', now: () => clock });
    expect(quota.update(new Headers({ 'content-type': 'application/json' }))).toBe(false);
    expect(quota.update(new Headers(OPENAI))).toBe(true);

    const fresh = quotaSnapshotSchema.parse(await quota.read());
    expect(fresh).toMatchObject({ agentId: 'openai-main', method: 'response-headers', stale: false, takenAt: '2026-11-01T12:00:00.000Z' });
    expect(fresh.buckets.map((b) => b.groupId)).toEqual(['requests', 'tokens']);

    clock = new Date('2026-11-01T12:11:00.000Z');
    const old = quotaSnapshotSchema.parse(await quota.read());
    expect(old.stale).toBe(true);
    // Ambos reinicios ya pasaron: se consideran repuestos.
    expect(old.buckets.every((b) => b.remainingFraction === 1)).toBe(true);
  });
});
