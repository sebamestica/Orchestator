/**
 * Cableado de los módulos de rutas de F5. Cada tarea agrega aquí una sola línea con su fábrica
 * (`(comp) => RouteModule`), así nadie más toca `src/core/server/app.ts` ni `compose.ts`.
 * Plan: docs/plan/F5-INTERFAZ.md §4.
 */
import type { RouteModule } from '../server/index.ts';
import type { Composition } from './compose.ts';
import { chatRouteModule } from './f5-chat.ts';
import { pluginsRouteModule } from './f5-plugins.ts';
import { settingsStoreFor } from '../settings/index.ts';
import { f5Servidor } from './f5-servidor.ts';
import { usageRouteModule } from './f5-uso.ts';
import { storageRouteModule } from './f5-almacenamiento.ts';

export type RouteModuleFactory = (comp: Composition) => RouteModule;

/** Fábricas en orden de registro. */
export const ROUTE_MODULE_FACTORIES: readonly RouteModuleFactory[] = [
  // c14-servidor-ui: ajustes, carpetas, proyecto desde carpeta, tarea manual, interfaz estática
  f5Servidor,
  // c15-chat: chats con la mente, adjuntos, propuestas
  (comp) => chatRouteModule(comp, { settings: () => settingsStoreFor(comp.store.database).get() }),
  // c16-plugins: Chrome y Canva
  pluginsRouteModule,
  // c29-uso: uso de tokens y gasto de la API por modelo (issue 5)
  usageRouteModule,
  // c34-almacenamiento: cuánto ocupa Berland en disco y su vaciado (issue 13)
  storageRouteModule,
];

export function routeModulesFor(comp: Composition): RouteModule[] {
  return ROUTE_MODULE_FACTORIES.map((make) => make(comp));
}
