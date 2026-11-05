import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentEventSchema, agentKindSchema, providerSchema, quotaMethodSchema, redactSecrets, taskStateSchema } from '../../src/shared/index.ts';
import { openApiPath, type Json, type JsonObject } from '../../docs/api/build.ts';
import { OPENAPI_FILE, POSTMAN_FILE, renderFiles } from '../../docs/api/generate.ts';
import { DEFAULT_PORT, docRoutes } from '../../docs/api/routes.ts';
import { wsClientMessageSchema, wsServerMessageSchema } from '../../docs/api/schemas.ts';
import { serverRoutes } from '../../docs/api/source.ts';
import { apiSchemas, type RouteSpec } from '../../src/core/server/index.ts';
import { QUARANTINE_ID_RE, lockEntrySchema, skillReviewSchema } from '../../src/core/skills/index.ts';
import * as ex from '../../docs/api/examples.ts';

const docsDir = new URL('../../docs/api/', import.meta.url);
const readText = (name: string): string => readFileSync(new URL(name, docsDir), 'utf8').replaceAll('\r\n', '\n');

const openapiText = readText(OPENAPI_FILE);
const postmanText = readText(POSTMAN_FILE);
const openapi = JSON.parse(openapiText) as JsonObject;
const postman = JSON.parse(postmanText) as JsonObject;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function isObj(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function obj(v: Json | undefined, where: string): JsonObject {
  if (!isObj(v)) throw new Error(`${where} no es un objeto`);
  return v;
}
function arr(v: Json | undefined, where: string): Json[] {
  if (!Array.isArray(v)) throw new Error(`${where} no es una lista`);
  return v;
}

/** Recorre todo el árbol y llama a `visit(clave, valor)` en cada propiedad. */
function walk(node: Json, visit: (key: string, value: Json) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit);
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

function resolvePointer(doc: Json, ref: string): Json | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let cur: Json | undefined = doc;
  for (const raw of ref.slice(2).split('/')) {
    const part = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (isObj(cur)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

interface Operation {
  method: string;
  path: string;
  op: JsonObject;
}
function operations(): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(obj(openapi.paths, 'paths'))) {
    for (const method of METHODS) {
      const op = obj(item, path)[method];
      if (op !== undefined) out.push({ method, path, op: obj(op, `${method} ${path}`) });
    }
  }
  return out;
}

interface PostmanRequest {
  name: string;
  item: JsonObject;
  request: JsonObject;
  url: JsonObject;
}
function postmanRequests(items: Json = postman.item ?? []): PostmanRequest[] {
  const out: PostmanRequest[] = [];
  for (const raw of arr(items, 'item')) {
    const item = obj(raw, 'item');
    if (item.item !== undefined) out.push(...postmanRequests(item.item));
    else {
      const request = obj(item.request, `request de ${String(item.name)}`);
      out.push({ name: String(item.name), item, request, url: obj(request.url, `url de ${String(item.name)}`) });
    }
  }
  return out;
}
const postmanPath = (url: JsonObject): string => `/${arr(url.path, 'url.path').map(String).join('/')}`;
const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${openApiPath(path)}`;

/** Todos los ejemplos de ambos archivos (cuerpos, respuestas, parámetros y variables), como texto. */
function exampleTexts(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  walk(openapi, (key, value) => {
    if (key === 'example' || key === 'examples' || key === 'default') out.push({ where: `openapi ${key}`, text: JSON.stringify(value) });
  });
  for (const r of postmanRequests()) {
    const body = r.request.body;
    if (isObj(body)) out.push({ where: `postman cuerpo ${r.name}`, text: String(body.raw) });
    out.push({ where: `postman url ${r.name}`, text: JSON.stringify(r.url) });
    for (const resp of arr(r.item.response ?? [], 'response')) out.push({ where: `postman respuesta ${r.name}`, text: String(obj(resp, 'response').body) });
  }
  for (const v of arr(postman.variable, 'variable')) out.push({ where: 'postman variable', text: JSON.stringify(v) });
  return out;
}

describe('docs/api: archivos generados', () => {
  it('ambos archivos son JSON válido con la versión esperada', () => {
    expect(openapi.openapi).toBe('3.1.0');
    expect(obj(openapi.info, 'info').title).toBe('Orquestador — API local');
    expect(obj(postman.info, 'info').schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(arr(postman.item, 'item').length).toBeGreaterThan(0);
  });

  it('están al día: el generador produce exactamente lo que hay en disco', () => {
    const files = renderFiles();
    expect(files.map((f) => f.name)).toEqual([OPENAPI_FILE, POSTMAN_FILE]);
    expect(files[0]?.content).toBe(openapiText);
    expect(files[1]?.content).toBe(postmanText);
  });

  it('los esquemas salen de los contratos Zod de src/shared', () => {
    const schemas = obj(obj(openapi.components, 'components').schemas, 'schemas');
    expect(obj(schemas.AgentKind, 'AgentKind').enum).toEqual(agentKindSchema.options);
    expect(obj(schemas.Provider, 'Provider').enum).toEqual(providerSchema.options);
    expect(obj(schemas.QuotaMethod, 'QuotaMethod').enum).toEqual(quotaMethodSchema.options);
    expect(obj(schemas.TaskState, 'TaskState').enum).toEqual(taskStateSchema.options);
    const variants = arr(obj(schemas.AgentEvent, 'AgentEvent').oneOf, 'AgentEvent.oneOf').map(
      (v) => obj(obj(obj(v, 'variante').properties, 'properties').type, 'type').const,
    );
    expect(variants).toEqual(agentEventSchema.options.map((o) => o.shape.type.value));
    // Los valores por defecto: obligatorios en la respuesta (TaskBrief), opcionales al crear (TaskBriefInput).
    expect(arr(obj(schemas.TaskBrief, 'TaskBrief').required, 'required')).toContain('contextRefs');
    expect(arr(obj(schemas.TaskBriefInput, 'TaskBriefInput').required, 'required')).not.toContain('contextRefs');
  });
});

describe('docs/api: rutas', () => {
  it('cada ruta de OpenAPI está en Postman y al revés (salvo el WebSocket, que va en la descripción)', () => {
    const http = operations().filter((o) => o.op['x-websocket'] !== true);
    const fromOpenapi = new Set(http.map((o) => routeKey(o.method, o.path)));
    const fromPostman = new Set(postmanRequests().map((r) => routeKey(String(r.request.method), postmanPath(r.url))));
    expect([...fromPostman].sort()).toEqual([...fromOpenapi].sort());
    expect(fromPostman.size).toBe(postmanRequests().length);
    // Y ambas coinciden con la tabla de rutas.
    const table = new Set(docRoutes().filter((r) => !r.websocket).map((r) => routeKey(r.method, r.path)));
    expect([...table].sort()).toEqual([...fromOpenapi].sort());
  });

  it('cubre todas las rutas del encargo', () => {
    const keys = new Set(operations().map((o) => routeKey(o.method, o.path)));
    const required = [
      'GET /health',
      'GET /agents',
      'POST /agents',
      'DELETE /agents/{id}',
      'POST /agents/{id}/probe',
      'GET /quotas',
      'POST /quotas/refresh',
      'GET /projects',
      'POST /plans',
      'GET /tasks',
      'POST /tasks/{id}/approve',
      'POST /tasks/{id}/cancel',
      'GET /sessions/{id}/events',
      'GET /usage',
      'GET /skills',
      'POST /skills/import',
      'POST /skills/{name}/approve',
      'POST /skills/{name}/reject',
      'GET /memory/{project}/context',
      'GET /ws',
    ];
    for (const key of required) expect(keys, key).toContain(key);
  });

  it('el WebSocket /ws está documentado en la descripción de la colección con todos sus mensajes', () => {
    const ws = operations().filter((o) => o.op['x-websocket'] === true);
    expect(ws.map((o) => o.path)).toEqual(['/ws']);
    const description = String(obj(postman.info, 'info').description);
    expect(description).toContain(`ws://127.0.0.1:${DEFAULT_PORT}/ws`);
    expect(description).toContain('Authorization: Bearer {{token}}');
    for (const o of [...wsServerMessageSchema.options, ...wsClientMessageSchema.options]) expect(description).toContain(`\`${o.shape.type.value}\``);
  });

  it('declara cada parámetro de ruta en OpenAPI y en Postman', () => {
    for (const { method, path, op } of operations()) {
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const declared = arr(op.parameters ?? [], 'parameters')
        .map((p) => obj(p, 'parameter'))
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      expect(declared, `${method} ${path}`).toEqual(names);
    }
    for (const r of postmanRequests()) {
      const names = arr(r.url.path, 'path')
        .map(String)
        .filter((seg) => seg.startsWith(':'))
        .map((seg) => seg.slice(1));
      const declared = arr(r.url.variable ?? [], 'variable').map((v) => obj(v, 'variable').key);
      expect(declared, r.name).toEqual(names);
      expect(String(r.url.raw).startsWith(`{{baseUrl}}${postmanPath(r.url)}`), r.name).toBe(true);
    }
  });

  it('operationId únicos y respuestas de error con el código que les corresponde', () => {
    const ids = operations().map((o) => String(o.op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    const responses = obj(obj(openapi.components, 'components').responses, 'responses');
    const statusOf: Record<string, string> = {
      invalid_request: 'E400',
      invalid_json: 'E400',
      unauthorized: 'E401',
      forbidden_host: 'E403',
      forbidden_origin: 'E403',
      not_found: 'E404',
      conflict: 'E409',
      payload_too_large: 'E413',
      unsupported_media_type: 'E415',
      probe_failed: 'E422',
      plan_invalid: 'E422',
      upgrade_required: 'E426',
      not_configured: 'E501',
    };
    for (const [name, raw] of Object.entries(responses)) {
      const media = obj(obj(obj(raw, name).content, 'content')['application/json'], 'media');
      for (const ex of Object.values(obj(media.examples, 'examples'))) {
        const code = String(obj(obj(obj(ex, 'ejemplo').value, 'value').error, 'error').code);
        expect(statusOf[code], `${name}: ${code}`).toBe(name);
      }
    }
  });
});

describe('docs/api: referencias', () => {
  it('todos los $ref son internos y resuelven', () => {
    const refs: string[] = [];
    walk(openapi, (key, value) => {
      if (key === '$ref') refs.push(String(value));
    });
    walk(postman, (key, value) => {
      if (key === '$ref') refs.push(String(value));
    });
    expect(refs.length).toBeGreaterThan(50);
    const broken = [...new Set(refs)].filter((ref) => resolvePointer(openapi, ref) === undefined);
    expect(broken).toEqual([]);
  });

  it('no quedan componentes sin usar', () => {
    const used = new Set<string>();
    walk(openapi, (key, value) => {
      if (key === '$ref') used.add(String(value));
    });
    const components = obj(openapi.components, 'components');
    const unused = [
      ...Object.keys(obj(components.schemas, 'schemas')).map((id) => `#/components/schemas/${id}`),
      ...Object.keys(obj(components.responses, 'responses')).map((id) => `#/components/responses/${id}`),
    ].filter((ref) => !used.has(ref));
    expect(unused).toEqual([]);
  });

  it('cada {{variable}} de Postman está declarada en la colección', () => {
    const declared = new Set(arr(postman.variable, 'variable').map((v) => String(obj(v, 'variable').key)));
    const used = new Set([...postmanText.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1] ?? ''));
    expect([...used].filter((v) => !declared.has(v))).toEqual([]);
  });
});

describe('docs/api: seguridad', () => {
  it('ningún ejemplo coincide con patrones de clave (redactSecrets(x) === x)', () => {
    const texts = exampleTexts();
    expect(texts.length).toBeGreaterThan(60);
    for (const { where, text } of texts) expect(redactSecrets(text), where).toBe(text);
    // Y los archivos completos tampoco.
    expect(redactSecrets(openapiText)).toBe(openapiText);
    expect(redactSecrets(postmanText)).toBe(postmanText);
  });

  it('la comprobación detecta una clave si alguien la pusiera en un ejemplo', () => {
    const fake = `sk-ant-api03-${'x'.repeat(10)}${Date.now().toString(36)}${'y'.repeat(12)}`;
    const tampered = JSON.parse(openapiText) as JsonObject;
    const op = obj(obj(obj(tampered.paths, 'paths')['/agents'], '/agents').post, 'post');
    const media = obj(obj(obj(op.requestBody, 'requestBody').content, 'content')['application/json'], 'media');
    obj(media.example, 'example').apiKey = fake;
    const text = JSON.stringify(tampered);
    expect(redactSecrets(text)).not.toBe(text);
  });

  it('la clave solo aparece en el cuerpo de POST /agents, nunca en una respuesta', () => {
    const doc = openapi;
    const SECRET_FIELDS = new Set(['apiKey', 'token', 'password', 'secret']);
    const found: string[] = [];
    const seen = new Set<string>();
    const visit = (node: Json, where: string): void => {
      walk(node, (key, value) => {
        if (key === '$ref') {
          const ref = String(value);
          if (!seen.has(ref)) {
            seen.add(ref);
            const target = resolvePointer(doc, ref);
            if (target !== undefined) visit(target, ref);
          }
        }
        if (key === 'properties' && isObj(value)) for (const p of Object.keys(value)) if (SECRET_FIELDS.has(p)) found.push(`${where}: ${p}`);
      });
    };
    for (const { method, path, op } of operations()) visit(obj(op.responses, 'responses'), `${method} ${path}`);
    expect(found).toEqual([]);

    // En las peticiones, solo AddAgentFromKeyRequest lleva `apiKey`.
    const withKey = Object.entries(obj(obj(openapi.components, 'components').schemas, 'schemas'))
      .filter(([, s]) => isObj(s) && isObj(s.properties) && 'apiKey' in s.properties)
      .map(([id]) => id);
    expect(withKey).toEqual(['AddAgentFromKeyRequest']);

    // Ni las respuestas de ejemplo de Postman ni las variables traen valores de secretos.
    for (const r of postmanRequests()) {
      for (const resp of arr(r.item.response ?? [], 'response')) expect(String(obj(resp, 'response').body), r.name).not.toMatch(/"apiKey"/);
    }
    const vars = Object.fromEntries(arr(postman.variable, 'variable').map((v) => [String(obj(v, 'variable').key), obj(v, 'variable').value]));
    expect(vars.token).toBe('');
    expect(vars.apiKey).toBe('');
    const addAgent = postmanRequests().find((r) => r.request.method === 'POST' && postmanPath(r.url) === '/agents');
    expect(JSON.parse(String(obj(addAgent?.request.body, 'body').raw))).toMatchObject({ apiKey: '{{apiKey}}' });
  });

  it('autenticación Bearer {{token}} a nivel de colección y en todas las operaciones de OpenAPI (como el servidor)', () => {
    expect(postman.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] });
    for (const r of postmanRequests()) expect(r.request.auth, `${r.name} hereda la autenticación`).toBeUndefined();
    const vars = Object.fromEntries(arr(postman.variable, 'variable').map((v) => [String(obj(v, 'variable').key), obj(v, 'variable').value]));
    expect(vars.baseUrl).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    expect(z.url().safeParse(vars.baseUrl).success).toBe(true);

    expect(openapi.security).toEqual([{ bearerAuth: [] }]);
    expect(obj(obj(openapi.components, 'components').securitySchemes, 'securitySchemes').bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    // El servidor exige el token en todas las rutas, /health y el handshake de /ws incluidos.
    for (const { method, path, op } of operations()) {
      expect(op.security, `${method} ${path} no anula la seguridad global`).toBeUndefined();
      expect(obj(op.responses, 'responses')['401'], `${method} ${path}`).toEqual({ $ref: '#/components/responses/E401' });
    }
  });
});

// ------------------------------------------------------------------------------------------------
// openapi.json frente a `createApp(...).routes`, sin pasar por docs/api/build.ts: si el servidor
// cambia una ruta, un esquema, un estado o un código de error, esta prueba falla.

/** JSON Schema comparable: sin anotaciones ni limpiezas de presentación, con los `$ref` resueltos. */
function normalize(node: Json): Json {
  if (Array.isArray(node)) return node.map(normalize);
  if (!isObj(node)) return node;
  if (typeof node.$ref === 'string') {
    const target = resolvePointer(openapi, node.$ref);
    if (target === undefined) throw new Error(`$ref roto: ${node.$ref}`);
    const rest = Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref'));
    return normalize({ ...obj(target, node.$ref), ...rest });
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (['description', 'discriminator', '$schema', '$id'].includes(k)) continue;
    if (k === 'pattern' && node.format === 'date-time') continue;
    if ((k === 'maximum' && v === Number.MAX_SAFE_INTEGER) || (k === 'minimum' && v === Number.MIN_SAFE_INTEGER)) continue;
    out[k] = normalize(v);
  }
  return out;
}
const zodJson = (schema: z.ZodType, io: 'input' | 'output'): Json =>
  normalize(JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: 'throw' }))) as Json);
const sameJson = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

describe('docs/api: openapi.json coincide con createApp(...).routes', () => {
  const server: readonly RouteSpec[] = serverRoutes();
  const byKey = new Map(operations().map((o) => [routeKey(o.method, o.path), o.op]));

  it('mismas rutas, ni una más ni una menos', () => {
    expect(server.length).toBe(49);
    expect([...byKey.keys()].sort()).toEqual(server.map((r) => routeKey(r.method, r.path)).sort());
  });

  it('misma etiqueta, resumen, descripción, estado y códigos de error en cada ruta', () => {
    const diffs: string[] = [];
    for (const r of server) {
      const key = routeKey(r.method, r.path);
      const op = obj(byKey.get(key), key);
      if (!sameJson(op.tags ?? null, [r.tag])) diffs.push(`${key}: etiqueta`);
      if (op.summary !== r.summary) diffs.push(`${key}: resumen`);
      if ((op.description ?? undefined) !== r.description) diffs.push(`${key}: descripción`);
      const codes = Object.keys(obj(op.responses, 'responses')).map(Number).sort((a, b) => a - b);
      const expected = [r.status ?? 200, 401, 403, ...(r.errors ?? [])].sort((a, b) => a - b);
      if (!sameJson(codes, [...new Set(expected)])) diffs.push(`${key}: códigos ${codes.join(',')} ≠ ${expected.join(',')}`);
      if (Boolean(op['x-websocket']) !== Boolean(r.websocket)) diffs.push(`${key}: websocket`);
    }
    expect(diffs).toEqual([]);
  });

  it('mismos parámetros, cuerpo y respuesta (esquemas Zod del servidor convertidos con z.toJSONSchema)', () => {
    const diffs: string[] = [];
    for (const r of server) {
      const key = routeKey(r.method, r.path);
      const op = obj(byKey.get(key), key);
      const params = arr(op.parameters ?? [], 'parameters').map((p) => obj(p, 'parameter'));
      for (const where of ['path', 'query'] as const) {
        const schemas: Record<string, z.ZodType> = where === 'path' ? { ...(r.params ?? {}) } : { ...(r.query?.shape ?? {}) } as Record<string, z.ZodType>;
        const documented = params.filter((p) => p.in === where);
        if (!sameJson(documented.map((p) => String(p.name)).sort(), Object.keys(schemas).sort())) diffs.push(`${key}: parámetros ${where}`);
        for (const p of documented) {
          const schema = schemas[String(p.name)];
          if (!schema || !sameJson(normalize(p.schema ?? null), zodJson(schema, 'input'))) diffs.push(`${key}: esquema del parámetro ${String(p.name)}`);
          if (where === 'query' && p.required !== !schema?.safeParse(undefined).success) diffs.push(`${key}: obligatoriedad de ${String(p.name)}`);
        }
      }
      const body = isObj(op.requestBody) ? op.requestBody : undefined;
      if (Boolean(body) !== Boolean(r.body)) diffs.push(`${key}: cuerpo presente`);
      if (body && r.body) {
        if (body.required !== !r.bodyOptional) diffs.push(`${key}: cuerpo obligatorio`);
        const media = obj(obj(body.content, 'content')['application/json'], 'media');
        if (!sameJson(normalize(media.schema ?? null), zodJson(r.body, 'input'))) diffs.push(`${key}: esquema del cuerpo`);
        if (r.example !== undefined && !sameJson(media.example ?? null, JSON.parse(JSON.stringify(r.example)) as Json)) diffs.push(`${key}: ejemplo del cuerpo`);
      }
      const success = obj(obj(op.responses, 'responses')[String(r.status ?? 200)], `${key} éxito`);
      if (Boolean(success.content) !== Boolean(r.response)) diffs.push(`${key}: respuesta presente`);
      if (r.response) {
        const media = obj(obj(success.content, 'content')['application/json'], 'media');
        if (!sameJson(normalize(media.schema ?? null), zodJson(r.response, 'output'))) diffs.push(`${key}: esquema de la respuesta`);
        if (!r.response.safeParse(media.example).success) diffs.push(`${key}: la respuesta de ejemplo no cumple el esquema del servidor`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('los ejemplos de skills cumplen los esquemas del hub (src/core/skills)', () => {
    expect(skillReviewSchema.extend({ path: z.string().min(1) }).safeParse(ex.skillImport).success).toBe(true);
    expect(lockEntrySchema.safeParse(ex.skillApproved).success).toBe(true);
    expect(ex.skillRejected).toMatch(QUARANTINE_ID_RE);
  });

  it('el esquema de error es el del servidor', () => {
    const schema = obj(obj(obj(openapi.components, 'components').schemas, 'schemas').ErrorResponse, 'ErrorResponse');
    expect(normalize(schema)).toEqual(zodJson(apiSchemas.errorResponse, 'output'));
  });
});
