/**
 * Rutas del chat con la mente, adjuntos y propuestas (F5, c15). Toda entrada se valida con Zod (`ApiRouter`) y las
 * respuestas JSON salen tachadas. La respuesta de la mente llega por `/ws` (`event` con `sessionId = chat.sessionId`,
 * `chat`, `chat_message`, `proposals`, `chat_target`).
 */
import { z } from 'zod';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentByPathBody,
  attachmentSchema,
  chatMessageSchema,
  chatSchema,
  chatTargetResponse,
  createChatBody,
  idSchema,
  opaqueIdSchema,
  patchChatBody,
  proposalSchema,
  sendMessageBody,
} from '../../shared/index.ts';
import { ApiError, type RouteModuleContext } from '../server/index.ts';
import { AttachmentError, type AttachmentStore } from './attachments.ts';
import { ChatError, type ChatService } from './service.ts';

export const chatIdParam = opaqueIdSchema;
export const attachmentIdParam = opaqueIdSchema;
export const proposalTaskIdParam = idSchema;
/** `projectId` vacío: conversaciones sin proyecto; ausente: todos los chats. */
export const chatsQuery = z.strictObject({ projectId: z.union([idSchema, z.literal('')]).optional() });
export const messagesQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(5000).optional() });
export const uploadQuery = z.strictObject({ name: z.string().min(1).max(255) });

export const chatResponse = z.strictObject({ chat: chatSchema });
export const chatsResponse = z.strictObject({ chats: z.array(chatSchema) });
export const messageResponse = z.strictObject({ message: chatMessageSchema });
export const messagesResponse = z.strictObject({ messages: z.array(chatMessageSchema) });
export const proposalsResponse = z.strictObject({ proposals: z.array(proposalSchema) });
export const approvalResponse = z.strictObject({
  proposals: z.array(proposalSchema),
  /** Tareas que la flota aceptó (quedan `delegated` y pasan a `ready` en el tablero). */
  delivered: z.array(idSchema),
  /** Aprobadas que no se entregaron (siguen `approved`; aprobar de nuevo reintenta). */
  failed: z.array(z.strictObject({ taskId: idSchema, reason: z.string() })),
});
export const attachmentResponse = z.strictObject({ attachment: attachmentSchema });
export const chatDeletedResponse = z.strictObject({ deleted: z.literal(true), id: z.string() });

const CHAT_ERRORS = { invalid: [400, 'invalid_request'], not_found: [404, 'not_found'], conflict: [409, 'conflict'], not_configured: [409, 'not_configured'], too_large: [413, 'payload_too_large'] } as const;

/** Errores del chat y de los adjuntos → `ApiError` (los mensajes ya son seguros y en español). */
export function toChatApiError(err: unknown): unknown {
  if (err instanceof ChatError || err instanceof AttachmentError) {
    const [status, code] = CHAT_ERRORS[err.code];
    return new ApiError(status, code, err.message);
  }
  return err;
}

async function run<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toChatApiError(err);
  }
}

/** Tipo con que se sirve un adjunto: solo las imágenes van con su tipo; lo demás, como descarga opaca. */
function servedType(kind: string, mime: string): string {
  return kind === 'image' ? mime : 'application/octet-stream';
}

function contentDisposition(kind: string, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind === 'image' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export interface ChatRoutesDeps {
  service: ChatService;
  attachments: AttachmentStore;
}

export function registerChatRoutes(ctx: RouteModuleContext, deps: ChatRoutesDeps): void {
  const { r } = ctx;
  const { service, attachments } = deps;
  const chatId = { id: chatIdParam };

  // ---------------------------------------------------------------- chats
  r.add(
    {
      method: 'get',
      path: '/chats',
      tag: 'Chats',
      summary: 'Lista los chats con la mente (más recientes primero)',
      description: 'Con `projectId` los de ese proyecto; con `projectId=` (vacío) las conversaciones sin proyecto; sin él, todos.',
      query: chatsQuery,
      response: chatsResponse,
      errors: [400],
      queryExample: { projectId: 'vetworld' },
    },
    ({ query }) => ({ chats: service.list(query.projectId === undefined ? undefined : query.projectId === '' ? null : query.projectId) }),
  );
  r.add(
    {
      method: 'post',
      path: '/chats',
      tag: 'Chats',
      summary: 'Crea un chat con la mente',
      description:
        'La mente es el agente de `settings.mind.agentId` (o el primer Claude habilitado). `cwd` por defecto es la carpeta del proyecto; una conversación sin proyecto (`projectId: null`, sin flota) no la necesita: sin `cwd`, Berland le crea una carpeta interna propia. `mode` por defecto: `settings.defaultMode`; `chat` (como Claude Code, sin flota) vale también sin proyecto.',
      body: createChatBody,
      response: chatResponse,
      status: 201,
      errors: [400, 404, 409, 415],
      example: { projectId: 'vetworld', mode: 'plan' },
    },
    ({ body }) => run(() => ({ chat: service.create(body) })),
  );
  r.add(
    { method: 'get', path: '/chats/:id', tag: 'Chats', summary: 'Detalle de un chat', params: chatId, response: chatResponse, errors: [400, 404] },
    ({ params }) => run(() => ({ chat: service.get(params.id ?? '') })),
  );
  r.add(
    {
      method: 'patch',
      path: '/chats/:id',
      tag: 'Chats',
      summary: 'Renombra el chat, cambia el modo (Shift+Tab) o las carpetas extra',
      description:
        'El cambio de modo rige desde el turno siguiente; la guardia de herramientas lo ve al instante (en `plan`, `delegar` queda bloqueada; en `chat`, `crear_tareas` y `delegar`; fuera de `bypass` y `chat`, edición y shell).',
      params: chatId,
      body: patchChatBody,
      response: chatResponse,
      errors: [400, 404, 415],
      example: { mode: 'auto' },
    },
    ({ params, body }) => run(() => ({ chat: service.patch(params.id ?? '', body) })),
  );
  r.add(
    {
      method: 'delete',
      path: '/chats/:id',
      tag: 'Chats',
      summary: 'Borra el chat, sus mensajes y propuestas',
      description: 'Cierra la sesión de la mente. Las tareas ya entregadas a la flota siguen en el tablero.',
      params: chatId,
      response: chatDeletedResponse,
      errors: [400, 404],
    },
    ({ params }) =>
      run(async () => {
        const id = params.id ?? '';
        await service.delete(id);
        return { deleted: true as const, id };
      }),
  );
  r.add(
    {
      method: 'get',
      path: '/chats/:id/target',
      tag: 'Chats',
      summary: 'Dónde quedan los cambios del chat: en local o en el repositorio que indicó el usuario',
      description:
        '`local` por defecto (carpeta del proyecto o, sin proyecto, la del chat), con `git` (`none`, `local` o `remote`) y `worktrees` (el proyecto usa ramas `orq/…`). `remote` solo si la mente anotó con `crear_tareas.destino` el repositorio que indicó el usuario: `url` saneada, rama y `configured` (el remoto está en `git remote` de la carpeta). Berland no sube nada. Los cambios llegan por `/ws` como `chat_target`.',
      params: chatId,
      response: chatTargetResponse,
      errors: [400, 404],
    },
    ({ params }) => run(async () => ({ target: await service.target(params.id ?? '') })),
  );
  r.add(
    {
      method: 'post',
      path: '/chats/:id/close',
      tag: 'Chats',
      summary: 'Cierra el chat (corta el turno y la sesión; un mensaje nuevo lo reabre reanudado)',
      params: chatId,
      response: chatResponse,
      errors: [400, 404],
    },
    ({ params }) => run(() => ({ chat: service.close(params.id ?? '') })),
  );

  // ------------------------------------------------------------- mensajes
  r.add(
    {
      method: 'get',
      path: '/chats/:id/messages',
      tag: 'Chats',
      summary: 'Mensajes del chat (los últimos `limit`, 500 por defecto)',
      params: chatId,
      query: messagesQuery,
      response: messagesResponse,
      errors: [400, 404],
    },
    ({ params, query }) => run(() => ({ messages: service.messages(params.id ?? '', query.limit) })),
  );
  r.add(
    {
      method: 'post',
      path: '/chats/:id/messages',
      tag: 'Chats',
      summary: 'Envía un mensaje a la mente',
      description:
        'Responde en cuanto guarda el mensaje del usuario; la respuesta llega por `/ws`. Con un turno en curso, 409. Las imágenes adjuntas van como bloques de imagen (tope de 5 MB en base64); los demás archivos, como «Adjuntos: <ruta>» y su carpeta pasa a ser legible. `effort` (opcional) es el esfuerzo de este turno: sin él, el de los ajustes de la mente; se aplica en vivo, sin perder la conversación.',
      params: chatId,
      body: sendMessageBody,
      response: messageResponse,
      status: 201,
      errors: [400, 404, 409, 413, 415],
      example: { text: 'Separa la API y la interfaz del tablero', attachmentIds: [], effort: 'high' },
    },
    ({ params, body }) => run(async () => ({ message: await service.send(params.id ?? '', body) })),
  );
  r.add(
    { method: 'post', path: '/chats/:id/interrupt', tag: 'Chats', summary: 'Corta el turno en curso (la conversación sigue)', params: chatId, response: chatResponse, errors: [400, 404] },
    ({ params }) => run(async () => ({ chat: await service.interrupt(params.id ?? '') })),
  );

  // ----------------------------------------------------------- propuestas
  r.add(
    { method: 'get', path: '/chats/:id/proposals', tag: 'Chats', summary: 'Tareas propuestas por la mente en este chat', params: chatId, response: proposalsResponse, errors: [400, 404] },
    ({ params }) => run(() => ({ proposals: service.proposals(params.id ?? '') })),
  );
  r.add(
    {
      method: 'post',
      path: '/chats/:id/proposals/approve-all',
      tag: 'Chats',
      summary: 'Aprueba todas las propuestas pendientes y las entrega a la flota',
      description: 'En orden de dependencias. Las que no se pueden entregar quedan aprobadas y van en `failed`.',
      params: chatId,
      response: approvalResponse,
      errors: [400, 404, 409],
    },
    ({ params }) => run(() => service.approveAll(params.id ?? '')),
  );
  r.add(
    {
      method: 'post',
      path: '/chats/:id/proposals/:taskId/approve',
      tag: 'Chats',
      summary: 'Aprueba una propuesta: pasa a `ready` en el tablero y la flota la recibe',
      params: { ...chatId, taskId: proposalTaskIdParam },
      response: approvalResponse,
      errors: [400, 404, 409],
    },
    ({ params }) => run(() => service.approve(params.id ?? '', [params.taskId ?? ''])),
  );
  r.add(
    {
      method: 'post',
      path: '/chats/:id/proposals/:taskId/reject',
      tag: 'Chats',
      summary: 'Rechaza una propuesta (si aún no se entregó)',
      params: { ...chatId, taskId: proposalTaskIdParam },
      response: proposalsResponse,
      errors: [400, 404, 409],
    },
    ({ params }) => run(() => ({ proposals: service.reject(params.id ?? '', [params.taskId ?? '']) })),
  );

  // -------------------------------------------------------------- adjuntos
  // La subida trae hasta 20 MB de bytes crudos: tope propio en lugar del global de 1 MB.
  ctx.setBodyLimit('post', '/attachments', MAX_ATTACHMENT_BYTES);
  r.add(
    {
      method: 'post',
      path: '/attachments',
      tag: 'Adjuntos',
      summary: 'Sube un adjunto (cuerpo crudo con su Content-Type, hasta 20 MB)',
      description:
        'Imagen pegada o archivo soltado en la web: `POST /attachments?name=<archivo>` con los bytes como cuerpo. Se guarda en `<dataDir>/attachments/<id>/<nombre saneado>` (una carpeta por subida). `kind`: `image` (png, jpeg, gif o webp según sus bytes), `text` (tipos de texto y código) o `file`.',
      query: uploadQuery,
      response: attachmentResponse,
      status: 201,
      errors: [400, 413],
      queryExample: { name: 'captura.png' },
    },
    ({ c, query }) =>
      run(async () => {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        return { attachment: await attachments.upload({ name: query.name, mime: c.req.header('content-type'), bytes }) };
      }),
  );
  r.add(
    {
      method: 'post',
      path: '/attachments/by-path',
      tag: 'Adjuntos',
      summary: 'Registra un archivo local por su ruta (Electron), sin copiarlo',
      description: 'El archivo debe existir y pesar como mucho 20 MB.',
      body: attachmentByPathBody,
      response: attachmentResponse,
      status: 201,
      errors: [400, 404, 413, 415],
      example: { path: 'C:\\Users\\yo\\Desktop\\notas.md' },
    },
    ({ body }) => run(async () => ({ attachment: await attachments.registerPath(body.path) })),
  );
  r.add(
    {
      method: 'get',
      path: '/attachments/:id',
      tag: 'Adjuntos',
      summary: 'Bytes del adjunto (miniaturas)',
      description: 'Las imágenes salen con su tipo; el resto como `application/octet-stream` para descargar. Nunca se interpretan como página.',
      params: { id: attachmentIdParam },
      errors: [400, 404, 413],
    },
    ({ params }) =>
      run(async () => {
        const { attachment, bytes } = await attachments.read(params.id ?? '');
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            'Content-Type': servedType(attachment.kind, attachment.mime),
            'Content-Length': String(bytes.byteLength),
            'Content-Disposition': contentDisposition(attachment.kind, attachment.name),
            'Content-Security-Policy': "default-src 'none'; sandbox",
          },
        });
      }),
  );
}
