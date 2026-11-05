/**
 * Módulo de rutas de c34-almacenamiento (issue 13): cuánto ocupa Berland en disco y su vaciado (`GET /storage`,
 * `POST /storage/…`). Se cablea con una línea en `route-modules.ts`.
 *
 * Nunca se toca lo que la mente tampoco puede leer (`mindDenyPaths`: bóveda, base con `-wal` y `-shm`, memoria de
 * Obsidian), ni los proyectos con su raíz de worktrees (los lee el módulo del almacén en cada acción).
 */
import { join } from 'node:path';
import { conversationsRoot } from '../chat/conversations.ts';
import type { RouteModule } from '../server/index.ts';
import { createStorageRoutes } from '../storage-stats/index.ts';
import type { Composition } from './compose.ts';
import { mindDenyPaths } from './conductor.ts';

/** Fábrica para `ROUTE_MODULE_FACTORIES`: carpetas de datos de la composición. */
export function storageRouteModule(comp: Composition): RouteModule {
  const dataDir = comp.config.dataDir;
  return createStorageRoutes({
    dataDir,
    dbPath: comp.config.dbPath,
    attachmentsDir: join(dataDir, 'attachments'),
    conversationsRoot: conversationsRoot(dataDir),
    protectedPaths: () => mindDenyPaths(comp),
  });
}
