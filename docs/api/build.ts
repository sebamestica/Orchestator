/**
 * Construye openapi.json (OpenAPI 3.1) y la colección de Postman (v2.1) a partir de las rutas reales
 * del servidor (`createApp(...).routes`) y sus esquemas Zod. Deterministas: la misma entrada da el
 * mismo JSON. Los esquemas salen de `z.toJSONSchema` (Zod 4) y cada ejemplo se valida con su esquema.
 */
import { z } from 'zod';
import { apiSchemas, type ApiErrorCode } from '../../src/core/server/index.ts';
import { redactSecrets } from '../../src/shared/index.ts';
import * as ex from './examples.ts';
import { API_VERSION, DEFAULT_PORT, collectionVariables, docRoutes, routeKey, tags, type DocRoute } from './routes.ts';
import {
  componentDescriptions,
  docsMetadata,
  inputComponents,
  outputComponents,
  wsClientMessageSchema,
  wsServerMessageSchema,
  type ComponentMeta,
} from './schemas.ts';

const errorResponse = apiSchemas.errorResponse;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

type Io = 'input' | 'output';

const COMPONENT_REF = '#/components/schemas/';
const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
/** Id fijo para que reimportar la colección en Postman la reemplace en vez de duplicarla. */
const POSTMAN_ID = '6f0c2a7e-3b1d-4e8a-9c55-0d7b8e41a2f3';

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Limpieza de presentación sobre lo que emite Zod (no cambia qué valores son válidos en la práctica):
 * - `$schema`/`$id` sobran dentro de `components` (OpenAPI 3.1 ya fija el dialecto 2020-12);
 * - el `pattern` que Zod agrega a `format: date-time` repite el formato con ~400 caracteres;
 * - los límites ±2^53−1 que Zod pone a los enteros son los de JavaScript, no de la API.
 */
function tidy(node: Json): Json {
  if (Array.isArray(node)) return node.map(tidy);
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === '$id') continue;
    if (key === 'pattern' && node.format === 'date-time') continue;
    if ((key === 'maximum' && value === Number.MAX_SAFE_INTEGER) || (key === 'minimum' && value === Number.MIN_SAFE_INTEGER)) continue;
    out[key] = tidy(value);
  }
  return out;
}

/** Uniones con discriminante `type` (eventos y mensajes del WebSocket): OpenAPI lo declara aparte. */
const DISCRIMINATED = new Set(['AgentEvent', 'WsServerMessage', 'WsClientMessage']);

/** `z.toJSONSchema` de un esquema suelto, con las descripciones de la documentación. */
function inlineSchema(schema: z.ZodType, io: Io): Json {
  return tidy(toJson(z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'throw', metadata: docsMetadata })));
}

function registrySchemas(registry: z.core.$ZodRegistry<ComponentMeta>, io: Io): Record<string, Json> {
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'throw',
    metadata: docsMetadata,
    uri: (id) => `${COMPONENT_REF}${id}`,
  });
  if ('__shared' in schemas) throw new Error('Esquemas compartidos sin id: regístralos en schemas.ts');
  const out: Record<string, Json> = {};
  for (const [id, schema] of Object.entries(schemas)) {
    const tidied = tidy(toJson(schema));
    if (!isObject(tidied)) throw new Error(`Componente ${id}: esquema inesperado`);
    const description = componentDescriptions[id];
    if (description && tidied.description === undefined) tidied.description = description;
    if (DISCRIMINATED.has(id)) tidied.discriminator = { propertyName: 'type' };
    out[id] = tidied;
  }
  return out;
}

/** `components.schemas`: componentes de respuesta (salida) y de petición (entrada) de los registros. */
export function componentSchemas(): Record<string, Json> {
  const output = registrySchemas(outputComponents, 'output');
  const input = registrySchemas(inputComponents, 'input');
  const merged: Record<string, Json> = { ...output };
  for (const [id, schema] of Object.entries(input)) {
    const existing = merged[id];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(schema)) {
      throw new Error(`El componente ${id} difiere entre entrada y salida: usa ids distintos`);
    }
    merged[id] = schema;
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

function schemaFor(schema: z.ZodType, io: Io): Json {
  const registry = io === 'input' ? inputComponents : outputComponents;
  const id = registry.get(schema)?.id;
  if (id) return { $ref: `${COMPONENT_REF}${id}` };
  return inlineSchema(schema, io);
}

function check(schema: z.ZodType, value: unknown, where: string): void {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`Ejemplo inválido en ${where}: ${z.prettifyError(r.error)}`);
}

export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, '{$1}');
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? '');
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `post /agents/:id/probe` → `postAgentsByIdProbe`. */
export function operationId(route: Pick<DocRoute, 'method' | 'path'>): string {
  const parts = route.path
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? `By${upperFirst(seg.slice(1))}` : seg.split(/[^A-Za-z0-9]+/).map(upperFirst).join('')));
  return route.method + parts.join('');
}

function variableValue(route: DocRoute, param: string): string {
  const name = route.paramVars?.[param];
  if (!name) throw new Error(`${routeKey(route)}: falta paramVars.${param} en docExtras (docs/api/routes.ts)`);
  return collectionVariables[name].value;
}

/** Valida todos los ejemplos de una ruta contra sus esquemas. */
export function checkRouteExamples(route: DocRoute): void {
  const where = routeKey(route);
  for (const p of pathParamNames(route.path)) {
    const schema = route.params?.[p];
    if (!schema) throw new Error(`${where}: falta el esquema del parámetro ${p}`);
    check(schema, variableValue(route, p), `${where} (parámetro ${p})`);
  }
  if (route.query) check(route.query, route.queryExample ?? {}, `${where} (consulta)`);
  else if (route.queryExample) throw new Error(`${where}: queryExample sin query`);
  if (route.body) {
    if (route.example === undefined && !route.bodyOptional) throw new Error(`${where}: falta el ejemplo del cuerpo`);
    if (route.example !== undefined) check(route.body, route.example, `${where} (cuerpo)`);
  } else if (route.example !== undefined || route.postmanExample !== undefined) {
    throw new Error(`${where}: ejemplo de cuerpo sin esquema`);
  }
  if (route.response) {
    if (route.responseExample === undefined) throw new Error(`${where}: falta responseExample en docExtras (docs/api/routes.ts)`);
    check(route.response, route.responseExample, `${where} (respuesta)`);
  }
}

// ---------------------------------------------------------------------------- errores

interface ErrorDoc {
  description: string;
  examples: readonly { code: ApiErrorCode; message: string }[];
}

/** Respuestas de error comunes (`components.responses.E<código>`); mensajes como los del servidor. */
const ERROR_DOCS: Readonly<Record<number, ErrorDoc>> = {
  400: {
    description: 'Entrada inválida (Zod) o cuerpo que no es JSON.',
    examples: [
      { code: 'invalid_request', message: 'Entrada inválida: body.displayName: Too small: expected string to have >=1 characters' },
      { code: 'invalid_json', message: 'El cuerpo no es JSON válido' },
    ],
  },
  401: { description: 'Falta `Authorization: Bearer <token>` o el token no es el de este arranque.', examples: [{ code: 'unauthorized', message: 'Falta el token o no es válido' }] },
  403: {
    description: 'Host distinto de `127.0.0.1:<puerto>` o `localhost:<puerto>` (DNS rebinding), u `Origin` no permitido (sin CORS).',
    examples: [
      { code: 'forbidden_host', message: 'Host no permitido' },
      { code: 'forbidden_origin', message: 'Origen no permitido' },
    ],
  },
  404: { description: 'No existe el recurso o la ruta.', examples: [{ code: 'not_found', message: 'No existe el agente claude-mi-clave' }] },
  409: { description: 'Ya existe, o el estado actual no permite la operación.', examples: [{ code: 'conflict', message: 'La tarea validar-citas está en estado running' }] },
  413: { description: 'El cuerpo supera el tamaño máximo (1 MiB por defecto).', examples: [{ code: 'payload_too_large', message: 'El cuerpo supera el tamaño máximo' }] },
  415: { description: 'Falta `Content-Type: application/json`.', examples: [{ code: 'unsupported_media_type', message: 'Usa Content-Type: application/json' }] },
  422: {
    description: 'La prueba del agente falló (`probe_failed`, con `warnings`) o el planificador no produjo un plan válido (`plan_invalid`, con `issues`).',
    examples: [
      { code: 'probe_failed', message: 'El proveedor rechazó la clave' },
      { code: 'plan_invalid', message: 'El planificador no produjo un plan válido' },
    ],
  },
  426: { description: 'Se pidió `/ws` sin `Upgrade: websocket`.', examples: [{ code: 'upgrade_required', message: 'Conecta por WebSocket (Upgrade: websocket)' }] },
  501: { description: 'El módulo que atiende la ruta no está configurado en este arranque.', examples: [{ code: 'not_configured', message: 'El planificador no está configurado en este arranque' }] },
};

function errorResponses(): JsonObject {
  const out: JsonObject = {};
  for (const [status, doc] of Object.entries(ERROR_DOCS)) {
    const examples: JsonObject = {};
    for (const e of doc.examples) {
      const value = { error: { code: e.code, message: e.message } };
      check(errorResponse, value, `error ${status}`);
      examples[e.code] = { value };
    }
    const response: JsonObject = {
      description: doc.description,
      content: { 'application/json': { schema: schemaFor(errorResponse, 'output'), examples } },
    };
    if (status === '401') {
      response.headers = { 'WWW-Authenticate': { description: 'Siempre `Bearer realm="orquestador"`.', schema: { type: 'string' } } };
    }
    out[`E${status}`] = response;
  }
  return out;
}

function errorCodesOf(route: DocRoute): number[] {
  const codes = new Set<number>([401, 403, ...(route.errors ?? [])]);
  for (const c of codes) if (!ERROR_DOCS[c]) throw new Error(`${routeKey(route)}: falta ERROR_DOCS[${c}]`);
  return [...codes].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------- OpenAPI

const SUCCESS_TEXT: Readonly<Record<number, string>> = { 200: 'OK', 201: 'Creado', 101: 'Cambio a WebSocket' };

function queryParameters(route: DocRoute): JsonObject[] {
  if (!route.query) return [];
  return Object.entries(route.query.shape).map(([name, field]) => {
    const schema = inlineSchema(field as z.ZodType, 'input');
    const param: JsonObject = { name, in: 'query', required: !(field as z.ZodType).safeParse(undefined).success };
    if (isObject(schema) && typeof schema.description === 'string') {
      param.description = schema.description;
      delete schema.description;
    }
    param.schema = schema;
    const example = route.queryExample?.[name];
    // En la URL todo es texto; el ejemplo de OpenAPI lleva el valor ya convertido (p. ej. `since: -1`).
    if (example !== undefined) param.example = toJson((field as z.ZodType).parse(example));
    return param;
  });
}

function openApiOperation(route: DocRoute): JsonObject {
  checkRouteExamples(route);
  const op: JsonObject = { tags: [route.tag], summary: route.summary, operationId: operationId(route) };
  if (route.description) op.description = route.description;
  const parameters: JsonObject[] = pathParamNames(route.path).map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: inlineSchema(route.params?.[name] as z.ZodType, 'input'),
    example: variableValue(route, name),
  }));
  parameters.push(...queryParameters(route));
  if (parameters.length) op.parameters = parameters;
  if (route.body) {
    const media: JsonObject = { schema: schemaFor(route.body, 'input') };
    if (route.example !== undefined) media.example = toJson(route.example);
    op.requestBody = { required: !route.bodyOptional, content: { 'application/json': media } };
  }
  const status = route.status ?? 200;
  const success: JsonObject = { description: SUCCESS_TEXT[status] ?? 'OK' };
  if (route.response) {
    success.content = { 'application/json': { schema: schemaFor(route.response, 'output'), example: toJson(route.responseExample) } };
  }
  const responses: JsonObject = { [String(status)]: success };
  for (const code of errorCodesOf(route)) responses[String(code)] = { $ref: `#/components/responses/E${code}` };
  op.responses = responses;
  if (route.websocket) {
    op['x-websocket'] = true;
    op['x-websocket-messages'] = { server: schemaFor(wsServerMessageSchema, 'output'), client: schemaFor(wsClientMessageSchema, 'input') };
  }
  return op;
}

export function buildOpenApi(routeList: readonly DocRoute[] = docRoutes()): JsonObject {
  const paths: JsonObject = {};
  const seen = new Set<string>();
  for (const route of routeList) {
    const id = operationId(route);
    if (seen.has(id)) throw new Error(`operationId repetido: ${id}`);
    seen.add(id);
    const key = openApiPath(route.path);
    const item = paths[key];
    const ops: JsonObject = isObject(item) ? item : {};
    ops[route.method] = openApiOperation(route);
    paths[key] = ops;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Orquestador — API local',
      version: API_VERSION,
      summary: 'REST + WebSocket del núcleo del orquestador (solo 127.0.0.1).',
      description: [
        'API local del núcleo. Escucha solo en `127.0.0.1` y exige `Authorization: Bearer <token>` en todas las rutas (también `/health` y el WebSocket `/ws`); el token es aleatorio y lo imprime el núcleo al arrancar.',
        '',
        'La interfaz web (`GET /`, `/index.html` y `/assets/*`, archivos de `dist/ui`) se sirve sin token y no es parte de esta API: abre el enlace `web: http://127.0.0.1:47811/#t=<token>` que imprime `iniciar` (el token va en el fragmento, que el navegador no envía). Las peticiones del navegador solo se aceptan desde el propio origen del núcleo o los de `ORQ_ALLOWED_ORIGINS`.',
        '',
        'Errores: siempre `{"error":{"code","message"}}` (más `warnings` o `issues` en 422). Ninguna respuesta incluye claves: al agregar un agente la clave va en el cuerpo de la petición (`apiKey`) y la respuesta solo trae `secretRef`.',
        '',
        'Rutas y esquemas salen del servidor (`createApp(...).routes` en `src/core/server/`, que usa los contratos Zod de `src/shared/`) con `z.toJSONSchema`, mediante `docs/api/generate.ts`; no edites este archivo a mano.',
      ].join('\n'),
    },
    servers: [{ url: 'http://127.0.0.1:{port}', description: 'Núcleo local', variables: { port: { default: String(DEFAULT_PORT), description: 'Puerto (`ORQ_PORT`).' } } }],
    security: [{ bearerAuth: [] }],
    tags: tags.map((t) => ({ name: t.name, description: t.description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token aleatorio por arranque (256 bits, base64url) que imprime el núcleo al arrancar.' },
      },
      responses: errorResponses(),
      schemas: componentSchemas(),
    },
  };
}

// ---------------------------------------------------------------------------- Postman

const STATUS_NAME: Readonly<Record<number, string>> = { 200: 'OK', 201: 'Created' };

/** Valores de `type` de una unión discriminada (mensajes del WebSocket). */
export function discriminatorValues(schema: { options: readonly { shape: { type: { value: unknown } } }[] }): string[] {
  return schema.options.map((o) => String(o.shape.type.value));
}

function webSocketDescription(): string {
  return [
    '## WebSocket `/ws`',
    '',
    'Postman v2.1 no guarda peticiones WebSocket en colecciones: crea una a mano (New → WebSocket) con:',
    '',
    `- URL: \`ws://127.0.0.1:${DEFAULT_PORT}/ws\``,
    '- Encabezado: `Authorization: Bearer {{token}}`',
    '',
    'El token va en el encabezado del handshake, nunca en la URL. El `WebSocket` del navegador no puede mandar encabezados: la interfaz lo envía como subprotocolo (`Sec-WebSocket-Protocol: orq, orq.bearer.<token>`, con `orq` primero) y el servidor responde `orq`. Electron (proceso principal), Node (`ws`) y Postman usan el encabezado `Authorization`.',
    '',
    `Mensajes del servidor (esquema \`WsServerMessage\` en openapi.json): ${discriminatorValues(wsServerMessageSchema).map((t) => `\`${t}\``).join(', ')}.`,
    `Mensajes del cliente (esquema \`WsClientMessage\`): ${discriminatorValues(wsClientMessageSchema).map((t) => `\`${t}\``).join(', ')}. Ejemplo: \`{"type":"replay","sessionId":"${ex.ids.session}","since":-1}\`.`,
    '',
    'Tras reconectar, pide `replay` con el último `seq` recibido y descarta duplicados por `seq`: los eventos en vivo pueden llegar antes que la respuesta.',
  ].join('\n');
}

function collectionDescription(): string {
  return [
    'API local del núcleo del orquestador (REST + WebSocket, solo `127.0.0.1`). Generada por `docs/api/generate.ts` desde las rutas del servidor (`createApp(...).routes`) y sus esquemas Zod: no la edites a mano; vuelve a importarla tras regenerar.',
    '',
    '1. Arranca el núcleo y copia el `token` de la línea JSON que imprime.',
    '2. Pégalo en la variable de colección `token` (columna «Current value»). La autenticación `Bearer {{token}}` está definida en la colección y la heredan todas las peticiones.',
    '3. Prueba `GET /health`: si responde `200`, el núcleo está arriba y el token es válido.',
    '',
    'Errores: `{"error":{"code","message"}}`. Ninguna respuesta incluye claves: en `POST /agents` la clave va en el cuerpo (`{{apiKey}}`) y la respuesta solo trae `secretRef`.',
    '',
    webSocketDescription(),
  ].join('\n');
}

function postmanBody(value: unknown): JsonObject {
  return { mode: 'raw', raw: JSON.stringify(value, null, 2), options: { raw: { language: 'json' } } };
}

function postmanRequest(route: DocRoute): JsonObject {
  const segments = route.path.split('/').filter(Boolean);
  const query: JsonObject[] = [];
  if (route.query) {
    for (const p of queryParameters(route)) {
      const name = String(p.name);
      const example = route.queryExample?.[name];
      const entry: JsonObject = { key: name, value: example ?? '' };
      if (typeof p.description === 'string') entry.description = p.description;
      if (example === undefined) entry.disabled = true;
      query.push(entry);
    }
  }
  const enabled = query.filter((q) => q.disabled !== true).map((q) => `${String(q.key)}=${String(q.value)}`);
  const url: JsonObject = {
    raw: `{{baseUrl}}${route.path}${enabled.length ? `?${enabled.join('&')}` : ''}`,
    host: ['{{baseUrl}}'],
    path: segments,
  };
  if (query.length) url.query = query;
  const params = pathParamNames(route.path);
  if (params.length) {
    url.variable = params.map((name) => ({ key: name, value: `{{${route.paramVars?.[name] ?? name}}}` }));
  }
  const request: JsonObject = { method: route.method.toUpperCase(), header: [], url };
  const body = route.postmanExample ?? route.example;
  if (route.body && body !== undefined) {
    request.header = [{ key: 'Content-Type', value: 'application/json' }];
    request.body = postmanBody(body);
  }
  return request;
}

function postmanItem(route: DocRoute): JsonObject {
  const request = postmanRequest(route);
  const description = [route.summary, route.description ?? ''].filter(Boolean).join('\n\n');
  const item: JsonObject = { name: route.path, request: { ...request, description } };
  if (route.postmanTest?.length) {
    item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: [...route.postmanTest] } }];
  }
  const status = route.status ?? 200;
  item.response =
    route.responseExample === undefined
      ? []
      : [
          {
            name: `${status} ${STATUS_NAME[status] ?? 'OK'}`,
            originalRequest: request,
            status: STATUS_NAME[status] ?? 'OK',
            code: status,
            _postman_previewlanguage: 'json',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            cookie: [],
            body: JSON.stringify(route.responseExample, null, 2),
          },
        ];
  return item;
}

export function buildPostman(routeList: readonly DocRoute[] = docRoutes()): JsonObject {
  const folders: JsonObject[] = [];
  for (const tag of tags) {
    const items = routeList.filter((r) => r.tag === tag.name && !r.websocket);
    for (const r of items) checkRouteExamples(r);
    if (items.length) folders.push({ name: tag.name, description: tag.description, item: items.map(postmanItem) });
  }
  const unknownTag = routeList.find((r) => !tags.some((t) => t.name === r.tag));
  if (unknownTag) throw new Error(`Etiqueta sin declarar: ${unknownTag.tag}`);
  return {
    info: { _postman_id: POSTMAN_ID, name: 'Orquestador — API local', description: collectionDescription(), schema: POSTMAN_SCHEMA },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    variable: Object.entries(collectionVariables).map(([key, v]) => ({ key, value: v.value, type: 'string', description: v.description })),
    item: folders,
  };
}

/** Comprueba que el texto no contenga nada con forma de clave (lo que `redactSecrets` tacharía). */
export function assertNoSecrets(text: string, where: string): void {
  if (redactSecrets(text) !== text) throw new Error(`${where} contiene algo con forma de clave`);
}
