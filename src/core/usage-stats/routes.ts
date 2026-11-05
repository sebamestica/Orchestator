/**
 * Rutas del uso y gasto (issue 5): `GET /usage/summary`, `GET /usage/rates` y `PATCH /usage/rates`. Solo lectura
 * sobre las tablas del núcleo; la tarifa vive en la tabla propia del módulo. Se cablea en `app/f5-uso.ts`.
 */
import { patchUsageRatesBody, redactSecrets, usageRatesResponse, usageSummaryQuery, usageSummaryResponse } from '../../shared/index.ts';
import { ApiError } from '../server/errors.ts';
import type { RouteModule, RouteModuleContext } from '../server/index.ts';
import { UsageRates, UsageRatesError } from './rates.ts';
import { UsageStats, UsageStatsError } from './summary.ts';

export interface UsageRoutesOptions {
  /** Zona horaria por defecto de los días (la del núcleo, `config.timeZone`). */
  timeZone?: string;
  /** Agente de la mente (`CONDUCTOR_AGENT_ID`). */
  mindAgentId?: string;
}

function invalid<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof UsageStatsError || err instanceof UsageRatesError) throw new ApiError(400, 'invalid_request', redactSecrets(err.message).slice(0, 300));
    throw err;
  }
}

export function registerUsageRoutes(ctx: RouteModuleContext, opts: UsageRoutesOptions = {}): void {
  const rates = new UsageRates(ctx.store.database, { now: ctx.now });
  const stats = new UsageStats(ctx.store, {
    rates,
    now: ctx.now,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.mindAgentId ? { mindAgentId: opts.mindAgentId } : {}),
  });

  ctx.r.add(
    {
      method: 'get',
      path: '/usage/summary',
      tag: 'Uso',
      summary: 'Uso y gasto: totales de hoy, 7 días y el mes, y el rango por modelo, día, rol y proyecto',
      description:
        'Tokens separados (entrada nueva, caché escrita, caché leída, salida) y costo en USD: «estimado» con precios públicos (lo informa el SDK) y «con tu tarifa» (× el multiplicador de cada modelo). Codex y agy van aparte como suscripción, sin costo. `period` (today, week, month) o `from`/`to` (AAAA-MM-DD, en `tz`); sin nada, el mes calendario.',
      query: usageSummaryQuery,
      response: usageSummaryResponse,
      errors: [400],
      queryExample: { period: 'month' },
    },
    ({ query }) => invalid(() => stats.summary(query)),
  );

  ctx.r.add(
    {
      method: 'get',
      path: '/usage/rates',
      tag: 'Uso',
      summary: 'Tarifa propia: multiplicador por modelo sobre los precios públicos',
      response: usageRatesResponse,
    },
    () => ({ rates: rates.list() }),
  );

  ctx.r.add(
    {
      method: 'patch',
      path: '/usage/rates',
      tag: 'Uso',
      summary: 'Cambia el multiplicador de tu tarifa por modelo (null vuelve a 1)',
      body: patchUsageRatesBody,
      response: usageRatesResponse,
      errors: [400],
      example: { rates: { 'claude-opus-5-5': 1.3 } },
    },
    ({ body }) => invalid(() => ({ rates: rates.apply(body) })),
  );
}

/** Módulo de rutas para `createApp({ routeModules })`. */
export function createUsageRoutes(opts: UsageRoutesOptions = {}): RouteModule {
  return (ctx) => registerUsageRoutes(ctx, opts);
}
