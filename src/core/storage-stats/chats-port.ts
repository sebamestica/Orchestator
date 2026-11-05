/**
 * Chats en vivo y su borrado para el almacenamiento. El `ChatService` vive en el módulo del chat (`f5-chat.ts`), así
 * que por defecto se usan sus propias rutas dentro del proceso (`app.request`), con el token y el Host de la petición
 * que llegó: `GET /chats` trae el estado y los subagentes vivos (`backgroundTasks`, solo en memoria) y
 * `DELETE /chats/:id` borra igual que siempre (cierra la sesión, borra mensajes, propuestas y adjuntos propios y
 * difunde `chat_deleted`). El token no sale del proceso.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { chatSchema, redactSecrets } from '../../shared/index.ts';
import type { Chat } from '../../shared/index.ts';

export type LiveChat = Pick<Chat, 'id' | 'state' | 'backgroundTasks'>;

export interface StorageChatsPort {
  /** Chats con su estado en vivo; `null` si el chat no está disponible en este arranque. */
  list(): Promise<readonly LiveChat[] | null>;
  /** Borra el chat como `DELETE /chats/:id`. `missing`: ya no existía. */
  delete(chatId: string): Promise<'deleted' | 'missing'>;
}

export class StorageChatsError extends Error {
  override readonly name = 'StorageChatsError';
}

const chatsBody = z.object({ chats: z.array(chatSchema) });
const errorBody = z.object({ error: z.object({ message: z.string() }).loose() }).loose();

async function failure(res: Response, what: string): Promise<StorageChatsError> {
  let detail = `HTTP ${res.status}`;
  try {
    const parsed = errorBody.safeParse(await res.json());
    if (parsed.success) detail = parsed.data.error.message;
  } catch {
    // sin cuerpo JSON
  }
  return new StorageChatsError(redactSecrets(`${what}: ${detail}`).slice(0, 300));
}

/** Puerto sobre las rutas del chat de la misma app, con las credenciales de la petición `c`. */
export function inProcessChatsPort(app: Hono, c: Context): StorageChatsPort {
  const headers: Record<string, string> = {};
  const auth = c.req.header('authorization');
  const host = c.req.header('host');
  if (auth) headers.authorization = auth;
  if (host) headers.host = host;
  const url = (p: string) => new URL(p, c.req.url).toString();
  return {
    async list() {
      const res = await app.request(url('/chats'), { method: 'GET', headers });
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, 'No se pudo leer la lista de chats');
      return chatsBody.parse(await res.json()).chats;
    },
    async delete(chatId) {
      const res = await app.request(url(`/chats/${encodeURIComponent(chatId)}`), { method: 'DELETE', headers });
      if (res.status === 404) return 'missing';
      if (!res.ok) throw await failure(res, `No se pudo borrar el chat ${chatId}`);
      return 'deleted';
    },
  };
}
