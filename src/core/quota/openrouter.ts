import { z } from 'zod';
import type { QuotaProvider } from '../../shared/contracts.ts';
import type { QuotaBucket, QuotaSnapshot } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';

/**
 * Cupo de una clave de OpenRouter: `GET https://openrouter.ai/api/v1/key` con
 * `Authorization: Bearer <clave>` (documentación oficial: openrouter.ai/docs/api-reference/limits y
 * /authentication, consultadas el 2026-11-01). No gasta créditos. Los créditos de OpenRouter son USD.
 */

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

const nullableNumber = z.number().nullable().optional();

const budgetSchema = z.looseObject({
  scope: z.string(),
  limit_usd: z.number(),
  spend_usd: z.number().optional(),
  remaining_usd: z.number(),
  reset_interval: z.enum(['daily', 'weekly', 'monthly']).nullable().optional(),
  resets_at: z.string().nullable().optional(),
});

export const openRouterKeySchema = z.looseObject({
  data: z.looseObject({
    label: z.string().optional(),
    limit: nullableNumber,
    limit_reset: z.string().nullable().optional(),
    limit_remaining: nullableNumber,
    usage: z.number().optional(),
    usage_daily: z.number().optional(),
    usage_weekly: z.number().optional(),
    usage_monthly: z.number().optional(),
    is_free_tier: z.boolean().optional(),
    budgets: z.array(budgetSchema).optional(),
    effective_budget: budgetSchema.nullable().optional(),
    free_model_daily_requests: z
      .looseObject({ used: z.number(), limit: z.number(), remaining: z.number() })
      .nullable()
      .optional(),
  }),
});
export type OpenRouterKeyInfo = z.infer<typeof openRouterKeySchema>['data'];

export interface OpenRouterQuotaOptions {
  agentId: string;
  getApiKey: () => Promise<string | undefined> | string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Para pruebas o un proxy; por defecto el endpoint oficial. */
  url?: string;
  now?: () => Date;
  timeoutMs?: number;
}

type Window = QuotaBucket['window'];

function windowOf(interval: string | null | undefined): Window {
  if (interval === 'daily' || interval === 'weekly' || interval === 'monthly') return interval;
  return interval ? 'custom' : 'total';
}

/** Próximo inicio de día, semana (lunes) o mes en UTC. */
export function nextUtcReset(window: Window, now: Date): string | undefined {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (window === 'daily') return new Date(Date.UTC(y, m, d + 1)).toISOString();
  if (window === 'weekly') {
    const daysToMonday = ((8 - now.getUTCDay()) % 7) || 7;
    return new Date(Date.UTC(y, m, d + daysToMonday)).toISOString();
  }
  if (window === 'monthly') return new Date(Date.UTC(y, m + 1, 1)).toISOString();
  return undefined;
}

function fraction(remaining: number, limit: number): number | null {
  if (!(limit > 0)) return null;
  return Math.min(1, Math.max(0, remaining / limit));
}

function isoOrUndefined(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const SCOPE_NAMES: Readonly<Record<string, string>> = {
  key_limit: 'Límite de la clave',
  api_key: 'Presupuesto de la clave',
  member: 'Presupuesto del miembro',
  workspace: 'Presupuesto del espacio de trabajo',
  workspace_default_member: 'Presupuesto por defecto del miembro',
  workspace_default_key: 'Presupuesto por defecto de la clave',
};

/** Convierte la respuesta de `/api/v1/key` en buckets. */
export function openRouterBuckets(info: OpenRouterKeyInfo, now: Date): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  const budgets = info.budgets ?? [];
  const hasKeyLimitBudget = budgets.some((b) => b.scope === 'key_limit');

  if (info.limit != null && !hasKeyLimitBudget) {
    const window = windowOf(info.limit_reset);
    const remaining = info.limit_remaining ?? Math.max(0, info.limit - (info.usage ?? 0));
    const bucket: QuotaBucket = {
      groupId: 'key_limit',
      groupName: SCOPE_NAMES.key_limit as string,
      window,
      remainingFraction: fraction(remaining, info.limit),
      remainingUnits: { amount: remaining, unit: 'usd' },
    };
    const resetAt = nextUtcReset(window, now);
    if (resetAt) bucket.resetAt = resetAt;
    buckets.push(bucket);
  }

  budgets.forEach((b, i) => {
    const window = windowOf(b.reset_interval);
    const bucket: QuotaBucket = {
      groupId: b.scope === 'key_limit' ? 'key_limit' : `${b.scope}-${i}`,
      groupName: SCOPE_NAMES[b.scope] ?? b.scope,
      window,
      remainingFraction: fraction(Math.max(0, b.remaining_usd), b.limit_usd),
      remainingUnits: { amount: Math.max(0, b.remaining_usd), unit: 'usd' },
    };
    const resetAt = isoOrUndefined(b.resets_at) ?? nextUtcReset(window, now);
    if (resetAt) bucket.resetAt = resetAt;
    buckets.push(bucket);
  });

  const free = info.free_model_daily_requests;
  if (free) {
    buckets.push({
      groupId: 'free_models',
      groupName: 'Modelos gratuitos (solicitudes diarias)',
      window: 'daily',
      remainingFraction: fraction(free.remaining, free.limit),
      remainingUnits: { amount: free.remaining, unit: 'requests' },
      resetAt: nextUtcReset('daily', now) as string,
    });
  }

  if (buckets.length === 0) {
    // Clave sin límite: el saldo depende de la cuenta; se informa sin fracción.
    buckets.push({ groupId: 'key_limit', groupName: 'Clave sin límite', window: 'total', remainingFraction: null });
  }
  return buckets;
}

export class OpenRouterQuota implements QuotaProvider {
  readonly agentId: string;
  readonly #opts: OpenRouterQuotaOptions;

  constructor(opts: OpenRouterQuotaOptions) {
    this.agentId = opts.agentId;
    this.#opts = opts;
  }

  async read(): Promise<QuotaSnapshot> {
    const now = (this.#opts.now ?? (() => new Date()))();
    const base = { agentId: this.agentId, method: 'openrouter-key' as const, takenAt: now.toISOString() };
    const fail = (error: string): QuotaSnapshot => ({ ...base, buckets: [], stale: true, error });

    const key = await this.#opts.getApiKey();
    if (!key) return fail('Falta la clave de OpenRouter.');
    const doFetch = this.#opts.fetch ?? globalThis.fetch;
    try {
      const res = await doFetch(this.#opts.url ?? OPENROUTER_KEY_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 15_000),
      });
      if (res.status === 401 || res.status === 403) return fail(`OpenRouter rechazó la clave (HTTP ${res.status}).`);
      if (!res.ok) return fail(`OpenRouter respondió HTTP ${res.status}.`);
      const parsed = openRouterKeySchema.safeParse(await res.json());
      if (!parsed.success) return fail('Respuesta de OpenRouter con formato inesperado.');
      return { ...base, buckets: openRouterBuckets(parsed.data.data, now), stale: false };
    } catch (err) {
      return fail(redactSecrets(`No se pudo consultar OpenRouter: ${(err as Error).message}`, [key]));
    }
  }
}
