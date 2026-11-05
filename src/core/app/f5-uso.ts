/**
 * Módulo de rutas de c29-uso (issue 5): uso de tokens y gasto de la API por modelo (`GET /usage/summary`,
 * `GET|PATCH /usage/rates`). Se cablea con una línea en `route-modules.ts`.
 */
import { CONDUCTOR_AGENT_ID } from '../conductor/index.ts';
import type { RouteModule } from '../server/index.ts';
import { createUsageRoutes } from '../usage-stats/index.ts';
import type { Composition } from './compose.ts';

/** Fábrica para `ROUTE_MODULE_FACTORIES`: días en la zona horaria del núcleo y la mente como `orquestador`. */
export function usageRouteModule(comp: Composition): RouteModule {
  return createUsageRoutes({ timeZone: comp.config.timeZone, mindAgentId: CONDUCTOR_AGENT_ID });
}
