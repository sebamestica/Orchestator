/**
 * Ejecuta la colección de Postman contra la app real (`createApp`, en proceso, SQLite en memoria y
 * `validateResponses`): cada petición documentada debe ser aceptada por el servidor tal como está
 * escrita (ruta, consulta, encabezados y cuerpo) y responder con un estado documentado.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryApp } from '../../docs/api/source.ts';
import { docRoutes, routeKey } from '../../docs/api/routes.ts';
import { apiSchemas } from '../../src/core/server/index.ts';

const collection = z
  .object({
    variable: z.array(z.object({ key: z.string(), value: z.string() })),
    item: z.array(
      z.object({
        name: z.string(),
        item: z.array(
          z.object({
            name: z.string(),
            request: z.object({
              method: z.string(),
              header: z.array(z.object({ key: z.string(), value: z.string() })),
              url: z.object({
                path: z.array(z.string()),
                query: z.array(z.object({ key: z.string(), value: z.string(), disabled: z.boolean().optional() })).optional(),
                variable: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
              }),
              body: z.object({ mode: z.string(), raw: z.string().optional() }).optional(),
              auth: z.object({ type: z.string() }).optional(),
            }),
          }),
        ),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(new URL('../../docs/api/orquestador.postman_collection.json', import.meta.url), 'utf8')));

const app = createInMemoryApp({ validateResponses: true });
afterAll(() => app.close());

/** Clave falsa con forma real, generada en cada ejecución (nunca es una clave de verdad). */
const fakeKey = `sk-ant-api03-${randomBytes(24).toString('hex')}`;
const vars: Record<string, string> = {
  ...Object.fromEntries(collection.variable.map((v) => [v.key, v.value])),
  token: app.token,
  apiKey: fakeKey,
};
const fill = (text: string): string => text.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => vars[name] ?? `{{${name}}}`);

const requests = collection.item.flatMap((folder) => folder.item.map((i) => i.request));
// Los DELETE al final, para que las demás peticiones encuentren el proyecto creado.
const ordered = [...requests.filter((r) => r.method !== 'DELETE'), ...requests.filter((r) => r.method === 'DELETE')];
const routes = new Map(docRoutes().map((r) => [routeKey(r), r]));

/** Estados que significan que la petición de ejemplo está mal escrita (o mal autenticada). */
const BROKEN = new Set([400, 401, 403, 413, 415, 500]);
/** Rechazos esperados del ejemplo: la vuelta de Canva lleva un `state` de marcador y responde 400 sin cambiar nada. */
const BY_DESIGN = new Map([['GET /plugins/canva/callback', 400]]);
/** Cuerpo de las peticiones que Postman envía como archivo (`mode: file`): un PNG mínimo (firma + IHDR). */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

describe('docs/api: la colección de Postman contra el servidor real', () => {
  it('cada petición se acepta tal como está escrita y responde con un estado documentado', async () => {
    const results: string[] = [];
    const failures: string[] = [];
    for (const req of ordered) {
      const vmap = new Map((req.url.variable ?? []).map((v) => [v.key, fill(v.value)]));
      const path = `/${req.url.path.map((seg) => (seg.startsWith(':') ? encodeURIComponent(vmap.get(seg.slice(1)) ?? seg) : seg)).join('/')}`;
      const template = `/${req.url.path.join('/')}`;
      const route = routes.get(`${req.method} ${template}`);
      if (!route) {
        failures.push(`${req.method} ${template}: no está en las rutas del servidor`);
        continue;
      }
      const query = (req.url.query ?? []).filter((q) => !q.disabled).map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(fill(q.value))}`);
      const headers: Record<string, string> = { host: app.host, ...(req.auth?.type === 'noauth' ? {} : { authorization: `Bearer ${app.token}` }) };
      for (const h of req.header) headers[h.key.toLowerCase()] = fill(h.value);
      const body = req.body?.mode === 'file' ? PNG : req.body?.raw !== undefined ? fill(req.body.raw) : undefined;
      const res = await app.core.app.request(`${path}${query.length ? `?${query.join('&')}` : ''}`, {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const text = await res.text();
      const key = `${req.method} ${template}`;
      const documented = new Set<number>([route.status ?? 200, ...(route.errors ?? [])]);
      results.push(`${key} → ${res.status}`);
      const broken = BY_DESIGN.has(key) ? BY_DESIGN.get(key) !== res.status : BROKEN.has(res.status);
      if (broken || !documented.has(res.status)) failures.push(`${key} → ${res.status} ${text.slice(0, 200)}`);
      if (text.includes(fakeKey)) failures.push(`${key}: la respuesta contiene la clave`);
      // La vuelta de Canva responde una página HTML: no hay JSON que validar.
      if (!res.headers.get('content-type')?.includes('application/json')) continue;
      const json: unknown = JSON.parse(text);
      const schema = res.status === (route.status ?? 200) ? route.response : apiSchemas.errorResponse;
      if (schema && !schema.safeParse(json).success) failures.push(`${key}: la respuesta no cumple su esquema`);
    }
    expect(failures).toEqual([]);
    // La colección cubre todas las rutas HTTP del servidor (el WebSocket va en la descripción).
    expect(results).toHaveLength([...routes.values()].filter((r) => !r.websocket).length);
    // Lo que sí funciona sin módulos externos (planificador, adaptadores, cupos, skills, memoria) responde 2xx.
    for (const ok of [
      'GET /health → 200',
      'POST /projects → 201',
      'POST /tasks → 201',
      'POST /tasks/:id/approve → 200',
      'POST /tasks/:id/cancel → 200',
      'DELETE /projects/:id → 200',
      'GET /chats → 200',
      'POST /attachments → 201',
      'GET /plugins → 200',
      'POST /plugins/:id/connect → 200',
      'POST /plugins/:id/disconnect → 200',
    ]) {
      expect(results).toContain(ok);
    }
  });

  it('sin token, toda ruta documentada responde 401 {error:{code:"unauthorized"}} (también /health y /ws), salvo las públicas', async () => {
    const failures: string[] = [];
    for (const route of docRoutes()) {
      if (route.public) {
        const res = await app.core.app.request(route.path, { method: route.method.toUpperCase(), headers: { host: app.host } });
        if (res.status === 401) failures.push(`${routeKey(route)} es pública y respondió 401`);
        continue;
      }
      const path = route.path.replace(/:([A-Za-z]+)/g, 'x1');
      const res = await app.core.app.request(path, { method: route.method.toUpperCase(), headers: { host: app.host } });
      const body: unknown = await res.json();
      const ok = res.status === 401 && apiSchemas.errorResponse.safeParse(body).success && z.object({ error: z.object({ code: z.literal('unauthorized') }) }).safeParse(body).success;
      if (!ok) failures.push(`${routeKey(route)} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });
});
