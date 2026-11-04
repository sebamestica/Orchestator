import { describe, expect, it } from 'vitest';
import { OPENROUTER_KEY_URL, OpenRouterQuota, nextUtcReset, openRouterBuckets } from '../../../src/core/quota/openrouter.ts';
import { quotaSnapshotSchema } from '../../../src/shared/index.ts';

// Clave ficticia con el formato de OpenRouter (no es real).
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const now = () => new Date('2026-10-08T15:30:00.000Z'); // jueves

/** Respuesta de ejemplo de la documentación oficial (openrouter.ai/docs/api-reference/limits, 2026-11-01). */
const DOC_EXAMPLE = {
  data: {
    label: 'sk-or-v1-0df...b1c',
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    include_byok_in_limit: false,
    usage: 25.5,
    usage_daily: 1.25,
    usage_weekly: 40,
    usage_monthly: 80,
    byok_usage: 0,
    byok_usage_daily: 0,
    byok_usage_weekly: 0,
    byok_usage_monthly: 0,
    is_free_tier: false,
    budgets: [
      {
        scope: 'workspace_default_member',
        guardrail_id: '0df9e665-d932-5740-b2c7-b52af166bc11',
        budget_id: null,
        limit_usd: 100,
        spend_usd: 40,
        remaining_usd: 60,
        reset_interval: 'weekly',
        resets_at: '2026-10-12T00:00:00.000Z',
        include_byok: false,
      },
      {
        scope: 'member',
        guardrail_id: '6b1d2c3e-4f50-4a61-9b72-83c4d5e6f708',
        budget_id: null,
        limit_usd: 50,
        spend_usd: 40,
        remaining_usd: 10,
        reset_interval: 'weekly',
        resets_at: '2026-10-12T00:00:00.000Z',
        include_byok: false,
      },
    ],
    effective_budget: {
      scope: 'member',
      guardrail_id: '6b1d2c3e-4f50-4a61-9b72-83c4d5e6f708',
      budget_id: null,
      limit_usd: 50,
      spend_usd: 40,
      remaining_usd: 10,
      reset_interval: 'weekly',
      resets_at: '2026-10-12T00:00:00.000Z',
      include_byok: false,
    },
    rate_limit: { requests: -1, interval: '10s' },
  },
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(respond: () => Response | Promise<Response>): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('OpenRouterQuota', () => {
  it('consulta /api/v1/key con Authorization: Bearer y convierte los presupuestos', async () => {
    const { fetch, calls } = mockFetch(() => json(DOC_EXAMPLE));
    const quota = new OpenRouterQuota({ agentId: 'openrouter', getApiKey: () => KEY, fetch, now });
    const snap = quotaSnapshotSchema.parse(await quota.read());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(OPENROUTER_KEY_URL);
    expect(calls[0]?.init?.method).toBe('GET');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    expect(snap).toMatchObject({ agentId: 'openrouter', method: 'openrouter-key', stale: false, takenAt: '2026-10-08T15:30:00.000Z' });
    expect(snap.buckets).toEqual([
      {
        groupId: 'workspace_default_member-0',
        groupName: 'Presupuesto por defecto del miembro',
        window: 'weekly',
        remainingFraction: 0.6,
        remainingUnits: { amount: 60, unit: 'usd' },
        resetAt: '2026-10-12T00:00:00.000Z',
      },
      {
        groupId: 'member-1',
        groupName: 'Presupuesto del miembro',
        window: 'weekly',
        remainingFraction: 0.2,
        remainingUnits: { amount: 10, unit: 'usd' },
        resetAt: '2026-10-12T00:00:00.000Z',
      },
    ]);
  });

  it('usa limit y limit_remaining de la clave con reinicio mensual', async () => {
    const body = { data: { label: 'x', limit: 20, limit_reset: 'monthly', limit_remaining: 5, usage: 15, usage_daily: 2, is_free_tier: false } };
    const { fetch } = mockFetch(() => json(body));
    const snap = quotaSnapshotSchema.parse(await new OpenRouterQuota({ agentId: 'openrouter', getApiKey: async () => KEY, fetch, now }).read());
    expect(snap.buckets).toEqual([
      {
        groupId: 'key_limit',
        groupName: 'Límite de la clave',
        window: 'monthly',
        remainingFraction: 0.25,
        remainingUnits: { amount: 5, unit: 'usd' },
        resetAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });

  it('calcula el restante si falta limit_remaining y añade el cupo de modelos gratuitos', () => {
    const buckets = openRouterBuckets(
      { limit: 10, limit_reset: null, usage: 4, free_model_daily_requests: { used: 30, limit: 50, remaining: 20 } },
      now(),
    );
    expect(buckets[0]).toEqual({ groupId: 'key_limit', groupName: 'Límite de la clave', window: 'total', remainingFraction: 0.6, remainingUnits: { amount: 6, unit: 'usd' } });
    expect(buckets[1]).toEqual({
      groupId: 'free_models',
      groupName: 'Modelos gratuitos (solicitudes diarias)',
      window: 'daily',
      remainingFraction: 0.4,
      remainingUnits: { amount: 20, unit: 'requests' },
      resetAt: '2026-10-09T00:00:00.000Z',
    });
  });

  it('no duplica el límite de la clave cuando también viene como presupuesto key_limit', () => {
    const buckets = openRouterBuckets(
      {
        limit: 10,
        limit_remaining: 4,
        budgets: [{ scope: 'key_limit', limit_usd: 10, spend_usd: 6, remaining_usd: 4, reset_interval: 'daily', resets_at: null }],
      },
      now(),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ groupId: 'key_limit', window: 'daily', remainingFraction: 0.4, resetAt: '2026-10-09T00:00:00.000Z' });
  });

  it('una clave sin límite se informa sin fracción', () => {
    expect(openRouterBuckets({ limit: null, limit_remaining: null, usage: 3 }, now())).toEqual([
      { groupId: 'key_limit', groupName: 'Clave sin límite', window: 'total', remainingFraction: null },
    ]);
  });

  it('informa errores sin lanzar: falta de clave, 401, HTTP 500, formato inesperado', async () => {
    const cases: [() => Response, RegExp][] = [
      [() => json({ error: { message: 'No auth credentials found' } }, 401), /rechazó la clave \(HTTP 401\)/],
      [() => json({}, 500), /HTTP 500/],
      [() => json({ data: { limit: 'mucho' } }), /formato inesperado/],
    ];
    for (const [respond, message] of cases) {
      const { fetch } = mockFetch(respond);
      const snap = quotaSnapshotSchema.parse(await new OpenRouterQuota({ agentId: 'openrouter', getApiKey: () => KEY, fetch, now }).read());
      expect(snap).toMatchObject({ stale: true, buckets: [] });
      expect(snap.error).toMatch(message);
    }
    const { fetch, calls } = mockFetch(() => json(DOC_EXAMPLE));
    const missing = await new OpenRouterQuota({ agentId: 'openrouter', getApiKey: () => undefined, fetch, now }).read();
    expect(missing.error).toMatch(/Falta la clave/);
    expect(calls).toHaveLength(0);
  });

  it('tacha la clave si aparece en un error de red', async () => {
    const { fetch } = mockFetch(() => {
      throw new Error(`connect ECONNREFUSED (clave ${KEY})`);
    });
    const snap = await new OpenRouterQuota({ agentId: 'openrouter', getApiKey: () => KEY, fetch, now }).read();
    expect(snap.error).toMatch(/No se pudo consultar OpenRouter/);
    expect(snap.error).not.toContain(KEY);
    expect(snap.error).toContain('[REDACTADO]');
  });
});

describe('nextUtcReset', () => {
  it('calcula el próximo día, lunes y mes en UTC', () => {
    const d = new Date('2026-10-08T15:30:00.000Z');
    expect(nextUtcReset('daily', d)).toBe('2026-10-09T00:00:00.000Z');
    expect(nextUtcReset('weekly', d)).toBe('2026-10-12T00:00:00.000Z');
    expect(nextUtcReset('weekly', new Date('2026-10-12T00:00:00.000Z'))).toBe('2026-10-19T00:00:00.000Z');
    expect(nextUtcReset('monthly', new Date('2026-12-15T00:00:00.000Z'))).toBe('2027-01-01T00:00:00.000Z');
    expect(nextUtcReset('total', d)).toBeUndefined();
  });
});
