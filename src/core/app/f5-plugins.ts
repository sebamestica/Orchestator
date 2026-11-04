/** Módulo de rutas de plugins (c16). El `PluginService` es el de la composición (`comp.plugins`). */
import type { RouteModule } from '../server/index.ts';
import { registerPluginRoutes, type PluginService } from '../plugins/index.ts';
import type { Composition } from './compose.ts';

/** El `PluginService` de la composición (uno por núcleo: estado, tokens en memoria y temporizador de refresco). */
export function pluginServiceFor(comp: Composition): PluginService {
  return comp.plugins;
}

/** Fábrica para `ROUTE_MODULE_FACTORIES`. */
export function pluginsRouteModule(comp: Composition): RouteModule {
  return (ctx) => registerPluginRoutes(ctx, pluginServiceFor(comp));
}
