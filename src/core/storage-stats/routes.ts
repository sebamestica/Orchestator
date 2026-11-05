/**
 * Rutas del almacenamiento (issue 13): `GET /storage` y el vaciado por categoría. Se cablean en
 * `app/f5-almacenamiento.ts`. Toda entrada se valida con Zod (`src/shared/api.ts`); cada acción responde lo borrado y
 * el resumen nuevo. Borrar chats usa las rutas del propio chat dentro del proceso (`inProcessChatsPort`).
 */
import type { Context } from 'hono';
import {
  redactSecrets,
  storageCleanAttachmentsBody,
  storageCleanChatsBody,
  storageCleanConversationsBody,
  storageCleanResponse,
  storageResponse,
} from '../../shared/index.ts';
import type { StorageCleanResult } from '../../shared/index.ts';
import { ApiError } from '../server/errors.ts';
import type { RouteModule, RouteModuleContext } from '../server/index.ts';
import { inProcessChatsPort, StorageChatsError, type LiveChat, type StorageChatsPort } from './chats-port.ts';
import { StorageError, StorageService, type StorageServiceOptions } from './service.ts';

export interface StorageRoutesOptions extends Omit<StorageServiceOptions, 'db' | 'projects' | 'now' | 'log'> {
  /** Chats en vivo y su borrado; por defecto las rutas `GET /chats` y `DELETE /chats/:id` de la misma app. */
  chats?: (c: Context) => StorageChatsPort;
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageError) throw new ApiError(err.code === 'conflict' ? 409 : 501, err.code, err.message);
    if (err instanceof StorageChatsError) throw new ApiError(409, 'conflict', redactSecrets(err.message).slice(0, 300));
    throw err;
  }
}

/** Chats en vivo, o `null` si el chat no está o no responde (se usa entonces el estado guardado en la base). */
async function liveChats(port: StorageChatsPort): Promise<readonly LiveChat[] | null> {
  try {
    return await port.list();
  } catch {
    return null;
  }
}

const CLEAN_ERRORS = [400, 409, 415] as const;

export function registerStorageRoutes(ctx: RouteModuleContext, opts: StorageRoutesOptions): void {
  const service = new StorageService({ ...opts, db: ctx.store.database, projects: () => ctx.store.listProjects(), now: ctx.now, ...(ctx.log ? { log: ctx.log } : {}) });
  const portFor = (c: Context) => (opts.chats ? opts.chats(c) : inProcessChatsPort(ctx.app, c));
  const respond = async (c: Context, result: StorageCleanResult) => ({ result, storage: await service.summary(await liveChats(portFor(c))) });

  ctx.r.add(
    {
      method: 'get',
      path: '/storage',
      tag: 'Almacenamiento',
      summary: 'Cuánto ocupa Berland en disco: adjuntos subidos, chats, carpetas de conversaciones y la base',
      description:
        'Bytes y cantidad por categoría. Los proyectos y sus worktrees no cuentan (son tus carpetas). Los bytes de los chats dentro de la base son aproximados (páginas de `dbstat` repartidas por el tamaño de las filas). `totalBytes` = adjuntos + carpetas de conversaciones + base (`.db`, `-wal` y `-shm`).',
      response: storageResponse,
    },
    ({ c }) => run(async () => ({ storage: await service.summary(await liveChats(portFor(c))) })),
  );

  ctx.r.add(
    {
      method: 'post',
      path: '/storage/attachments/clean',
      tag: 'Almacenamiento',
      summary: 'Vacía las imágenes y archivos subidos (los sin usar o todos)',
      description:
        '`orphans`: las copias que ningún mensaje usa (de chats borrados o nunca enviadas) y los archivos sueltos de la carpeta. `all`: todas las copias subidas; los chats conservan el texto. Nunca borra los archivos registrados por ruta (son tuyos), los de un chat que está respondiendo o con subagentes, ni lo subido hace menos de 1 h sin enviar. No se puede deshacer.',
      body: storageCleanAttachmentsBody,
      response: storageCleanResponse,
      errors: CLEAN_ERRORS,
      example: { scope: 'orphans' },
    },
    ({ c, body }) => run(async () => respond(c, await service.cleanAttachments(body.scope, await liveChats(portFor(c))))),
  );

  ctx.r.add(
    {
      method: 'post',
      path: '/storage/chats/clean',
      tag: 'Almacenamiento',
      summary: 'Borra chats (todos o los de más de N días) o los restos de chats ya borrados',
      description:
        'Cada chat se borra como `DELETE /chats/:id` (sesión, mensajes, propuestas y adjuntos propios) y además sus eventos, sus sesiones y las de sus subagentes, y su carpeta de conversación. Se conserva el historial de uso (`usage`). Los chats que están respondiendo o con subagentes trabajando se omiten (`skipped`). `leftovers`: mensajes, eventos y sesiones de chats ya borrados. Al final compacta la base (`compact: false` para no hacerlo). No se puede deshacer.',
      body: storageCleanChatsBody,
      response: storageCleanResponse,
      errors: [...CLEAN_ERRORS, 501],
      example: { scope: 'older', olderThanDays: 30 },
    },
    ({ c, body }) => run(async () => respond(c, await service.cleanChats(body, portFor(c)))),
  );

  ctx.r.add(
    {
      method: 'post',
      path: '/storage/conversations/clean',
      tag: 'Almacenamiento',
      summary: 'Borra las carpetas de conversaciones cuyo chat ya no existe',
      description:
        'Solo hijas directas de `berland-conversaciones` con nombre de chat, sin chat y sin cambios en la última hora. Los enlaces y junctions se quitan como enlace, sin entrar en ellos; nunca se toca un proyecto. No se puede deshacer.',
      body: storageCleanConversationsBody,
      response: storageCleanResponse,
      errors: CLEAN_ERRORS,
      example: { scope: 'orphans' },
    },
    ({ c }) => run(async () => respond(c, await service.cleanConversations())),
  );

  ctx.r.add(
    {
      method: 'post',
      path: '/storage/compact',
      tag: 'Almacenamiento',
      summary: 'Compacta la base (checkpoint del WAL + VACUUM) para liberar el espacio de lo borrado',
      description: 'Puede tardar unos segundos con una base grande. Si la base está ocupada, responde con un aviso en `warnings` y `compacted: false`.',
      response: storageCleanResponse,
      errors: [409],
    },
    ({ c }) => run(async () => respond(c, await service.compact())),
  );
}

/** Módulo de rutas para `createApp({ routeModules })`. */
export function createStorageRoutes(opts: StorageRoutesOptions): RouteModule {
  return (ctx) => registerStorageRoutes(ctx, opts);
}
