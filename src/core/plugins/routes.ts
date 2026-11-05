/**
 * Rutas de plugins (F5): `GET /plugins`, `POST /plugins/:id/connect`, `POST /plugins/:id/disconnect` y
 * `GET /plugins/canva/callback`. La última es la única sin token: la abre el navegador al volver de Canva y se
 * valida por un `state` de un solo uso que caduca a los 10 minutos.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { connectPluginBody, pluginIdSchema, pluginSchema, redactSecrets, type PluginId } from '../../shared/index.ts';
import type { RouteModuleContext } from '../server/app.ts';
import { ApiError } from '../server/errors.ts';
import { PluginError, type PluginService } from './service.ts';

export const CANVA_CALLBACK_PATH = '/plugins/canva/callback';

export const pluginsResponse = z.strictObject({ plugins: z.array(pluginSchema) });
export const pluginResponse = z.strictObject({ plugin: pluginSchema });
const pluginIdParam = z.string().pipe(pluginIdSchema);
/** Lo que Canva agrega al volver (RFC 6749 §4.1.2; `iss` de RFC 9207 y otros se ignoran). */
export const canvaCallbackQuery = z.looseObject({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

async function call<T>(service: PluginService, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const msg = redactSecrets(err instanceof Error ? err.message : String(err), service.knownSecrets()).slice(0, 300);
    if (err instanceof PluginError) {
      if (err.code === 'invalid') throw new ApiError(400, 'invalid_request', msg);
      if (err.code === 'not_found') throw new ApiError(404, 'not_found', msg);
      throw new ApiError(409, 'conflict', msg);
    }
    throw new ApiError(500, 'internal', `plugins: ${msg}`);
  }
}

/** URL del callback en este núcleo: siempre 127.0.0.1 (RFC 8252) y el puerto del Host ya validado por `hostGuard`. */
export function canvaRedirectUri(c: Context): string {
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  const port = /:(\d{1,5})$/.exec(host.trim())?.[1];
  if (!port) throw new ApiError(400, 'invalid_request', 'No se pudo saber el puerto del núcleo para el callback de Canva');
  return `http://127.0.0.1:${port}${CANVA_CALLBACK_PATH}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(c: Context, ok: boolean, title: string, message: string): Response {
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#090909;color:#ededed;font:16px/1.5 system-ui,sans-serif">
<main style="max-width:32rem;padding:2rem;text-align:center"><h1 style="font-size:1.4rem;margin:0 0 .5rem">${escapeHtml(title)}</h1><p style="margin:0;color:#a3a3a3">${escapeHtml(message)}</p></main>
</body></html>`;
  return c.html(html, ok ? 200 : 400);
}

export function registerPluginRoutes(ctx: RouteModuleContext, service: PluginService): void {
  const { r } = ctx;
  service.setPublisher((message) => ctx.hub.publish(message));

  r.add({ method: 'get', path: '/plugins', tag: 'Plugins', summary: 'Lista los plugins (Chrome, Canva) y su estado', response: pluginsResponse }, async () => ({
    plugins: await service.listLive(),
  }));
  r.add(
    {
      method: 'post',
      path: '/plugins/:id/connect',
      tag: 'Plugins',
      summary: 'Conecta un plugin',
      description:
        'Chrome («Probar conexión»): arranca el MCP `chrome-devtools-mcp` de tu Chrome personal (`--autoConnect`, el único navegador de los agentes), hace `initialize`, `tools/list` y `list_pages`, y lo cierra; responde `connected` (detalle: número de herramientas) o `error` con los pasos. Puede tardar hasta un minuto si Chrome pide aceptar la conexión. `profile: "agente"` (perfil aislado) ya no existe y responde 400. Canva: descubre el servidor OAuth, registra el cliente y responde `connecting` con `authUrl` (la abre la interfaz); termina en `GET /plugins/canva/callback`. `agents` vacío: el plugin llega a todos los agentes compatibles (Claude y Codex). Cada cambio se transmite por `/ws` como `{type:"plugin"}`.',
      params: { id: pluginIdParam },
      body: connectPluginBody,
      bodyOptional: true,
      response: pluginResponse,
      errors: [400, 415],
      example: {},
    },
    async ({ params, body, c }) => {
      const id = params.id as PluginId;
      const redirectUri = id === 'canva' ? canvaRedirectUri(c) : undefined;
      return { plugin: await call(service, () => service.connect(id, body, redirectUri ? { redirectUri } : {})) };
    },
  );
  r.add(
    {
      method: 'post',
      path: '/plugins/:id/disconnect',
      tag: 'Plugins',
      summary: 'Desconecta un plugin',
      description: 'Chrome: deja de entregarse a los agentes. Canva: revoca el token si el servidor lo permite y lo borra de la bóveda.',
      params: { id: pluginIdParam },
      response: pluginResponse,
      errors: [400],
    },
    async ({ params }) => ({ plugin: await call(service, () => service.disconnect(params.id as PluginId)) }),
  );

  ctx.allowWithoutToken?.('get', CANVA_CALLBACK_PATH);
  r.add(
    {
      method: 'get',
      path: CANVA_CALLBACK_PATH,
      tag: 'Plugins',
      summary: 'Vuelta de OAuth de Canva (sin token: la abre el navegador)',
      description:
        'Única ruta sin `Authorization`: la abre el navegador al volver de Canva. Se valida por `state` (un solo uso, caduca a los 10 minutos); con un `state` desconocido, repetido o vencido responde 400 y no cambia nada. Canjea el código (PKCE), guarda los tokens en la bóveda y responde una página HTML corta. Host y Origin se siguen comprobando.',
      query: canvaCallbackQuery,
      errors: [400],
      queryExample: { code: '<código>', state: '<state>' },
    },
    async ({ query, c }) => {
      const res = await service.handleCanvaCallback(query);
      return page(c, res.ok, res.title, res.message);
    },
  );
}
