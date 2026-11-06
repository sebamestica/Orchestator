/**
 * La documentación (openapi.json y la colección de Postman) cubre todas las rutas que registra el núcleo real: las
 * base de `createApp` y las de cada módulo de `ROUTE_MODULE_FACTORIES` (`routeModulesFor`). Un módulo nuevo sin
 * documentar hace fallar esta prueba.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compose } from '../../src/core/app/compose.ts';
import { routeModulesFor } from '../../src/core/app/route-modules.ts';
import { EventHub, createApp, generateToken } from '../../src/core/server/index.ts';
import { SqliteStore } from '../../src/core/store/index.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';

const docsDir = new URL('../../docs/api/', import.meta.url);
const readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(name, docsDir), 'utf8'));

const operation = z.looseObject({ security: z.array(z.unknown()).optional() });
const openapi = z
  .looseObject({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
  .parse(readJson('openapi.json'));
interface PostmanRequest {
  method: string;
  path: string;
  auth?: unknown;
}
const postmanItem = z.looseObject({
  item: z.array(z.unknown()).optional(),
  request: z.looseObject({ method: z.string(), url: z.looseObject({ path: z.array(z.string()) }), auth: z.unknown().optional() }).optional(),
});
function postmanRequests(items: readonly unknown[]): PostmanRequest[] {
  return items.flatMap((raw) => {
    const item = postmanItem.parse(raw);
    if (item.item) return postmanRequests(item.item);
    if (!item.request) return [];
    const { method, url, auth } = item.request;
    return [{ method, path: `/${url.path.join('/')}`, ...(auth !== undefined ? { auth } : {}) }];
  });
}
const postman = postmanRequests(z.looseObject({ item: z.array(z.unknown()) }).parse(readJson('orquestador.postman_collection.json')).item);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
/** `get /chats/:id` y `get /chats/{id}` → `GET /chats/{id}`. */
const key = (method: string, path: string): string => `${method.toUpperCase()} ${path.replace(/:([A-Za-z]+)/g, '{$1}')}`;
const openapiOps = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => HTTP_METHODS.has(method))
    .map(([method, op]) => ({ key: key(method, path), op: operation.parse(op) })),
);

/** El núcleo como lo arma `startCore`: composición en memoria y los módulos de `routeModulesFor`. */
const dir = mkdtempSync(join(tmpdir(), 'orq-docs-cobertura-'));
const comp = compose({
  store: new SqliteStore({ path: ':memory:' }),
  vault: new MemoryVault(),
  // Datos en una subcarpeta: las conversaciones van junto a ella, así también quedan en `dir`.
  env: { ORQ_DATA_DIR: join(dir, 'datos') },
  memoryDir: join(dir, 'memoria'),
  skillsHubDir: join(dir, 'hub'),
  projectDir: dir,
  detectors: [],
  hostEnv: () => ({}),
  routeModules: false,
});
const core = createApp({
  token: generateToken(),
  allowedHosts: () => ['127.0.0.1:47811'],
  store: comp.store,
  registry: comp.registry,
  hub: new EventHub(comp.store),
  routeModules: routeModulesFor(comp),
});
afterAll(() => {
  comp.store.close();
  comp.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('docs/api: cobertura frente al núcleo real (routeModulesFor)', () => {
  it('openapi.json y Postman tienen exactamente las rutas que registra el núcleo', () => {
    const real = core.routes.map((r) => key(r.method, r.path)).sort();
    expect(openapiOps.map((o) => o.key).sort()).toEqual(real);
    const http = core.routes.filter((r) => !r.websocket).map((r) => key(r.method, r.path)).sort();
    expect(postman.map((r) => key(r.method, r.path)).sort()).toEqual(http);
    for (const k of ['GET /chats', 'POST /chats/{id}/messages', 'POST /attachments', 'GET /attachments/{id}', 'GET /plugins', 'GET /plugins/canva/callback']) {
      expect(real).toContain(k);
    }
  });

  it('GET /plugins/canva/callback es la única ruta sin token: security [] en OpenAPI y noauth en Postman', () => {
    expect(core.publicRoutes).toEqual(['GET /plugins/canva/callback']);
    const open = openapiOps.filter((o) => o.op.security !== undefined);
    expect(open.map((o) => [o.key, o.op.security])).toEqual([['GET /plugins/canva/callback', []]]);
    const noauth = postman.filter((r) => r.auth !== undefined);
    expect(noauth).toEqual([{ method: 'GET', path: '/plugins/canva/callback', auth: { type: 'noauth' } }]);
  });
});
