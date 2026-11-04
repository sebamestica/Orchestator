import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { redactSecrets } from '../../shared/index.ts';
import { redactDeep } from '../store/index.ts';
import { ApiError } from './errors.ts';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** Descripción de una ruta: sirve para validar la entrada y para generar OpenAPI y Postman. */
export interface RouteSpec {
  method: HttpMethod;
  /** Ruta con la sintaxis de Hono (`/agents/:id`). */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  params?: Readonly<Record<string, z.ZodType<string>>>;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Si el cuerpo puede faltar (se valida como `{}`). */
  bodyOptional?: boolean;
  response?: z.ZodType;
  status?: 200 | 201 | 101;
  /** Códigos de error además de 401 y 403 (comunes a todas las rutas). */
  errors?: readonly ContentfulStatusCode[];
  /** Cuerpo de ejemplo para Postman. */
  example?: unknown;
  /** Valores de ejemplo para la consulta en Postman. */
  queryExample?: Readonly<Record<string, string>>;
  websocket?: boolean;
}

type Out<S, Fallback> = S extends z.ZodType ? z.output<S> : Fallback;

export interface RouteInput<S extends RouteSpec> {
  c: Context;
  params: Readonly<Record<string, string>>;
  query: Out<S['query'], Record<string, never>>;
  body: Out<S['body'], undefined>;
}

export interface RouterOptions {
  /** Valida cada respuesta con `spec.response` (en pruebas): una respuesta que no cumple da 500. */
  validateResponses?: boolean;
}

function issuesMessage(error: z.ZodError, where: string): string {
  const parts = error.issues.slice(0, 10).map((i) => `${[where, ...i.path].join('.')}: ${i.message}`);
  return redactSecrets(`Entrada inválida: ${parts.join('; ')}`).slice(0, 800);
}

function check<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(400, 'invalid_request', issuesMessage(r.error, where));
  return r.data;
}

async function readJsonBody(c: Context, optional: boolean): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === '') {
    if (optional) return {};
    throw new ApiError(400, 'invalid_request', 'Falta el cuerpo JSON');
  }
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new ApiError(415, 'unsupported_media_type', 'Usa Content-Type: application/json');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_json', 'El cuerpo no es JSON válido');
  }
}

/** Registra rutas en Hono y guarda su descripción. Toda respuesta JSON pasa por `redactDeep`. */
export class ApiRouter {
  readonly specs: RouteSpec[] = [];
  private readonly app: Hono;
  private readonly opts: RouterOptions;

  constructor(app: Hono, opts: RouterOptions = {}) {
    this.app = app;
    this.opts = opts;
  }

  add<const S extends RouteSpec>(spec: S, handler: (input: RouteInput<S>) => unknown): void {
    const pathParams = [...spec.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? '');
    for (const p of pathParams) {
      if (!spec.params?.[p]) throw new Error(`Ruta ${spec.path}: falta el esquema del parámetro ${p}`);
    }
    this.specs.push(spec);
    this.app.on(spec.method.toUpperCase(), spec.path, async (c) => {
      const params: Record<string, string> = {};
      for (const p of pathParams) params[p] = check(spec.params?.[p] as z.ZodType<string>, c.req.param(p), p);
      const query = spec.query ? check(spec.query, c.req.query(), 'query') : {};
      const body = spec.body ? check(spec.body, await readJsonBody(c, spec.bodyOptional ?? false), 'body') : undefined;
      const result = await handler({ c, params, query, body } as RouteInput<S>);
      if (result instanceof Response) return result;
      if (this.opts.validateResponses && spec.response) {
        const r = spec.response.safeParse(result);
        if (!r.success) throw new Error(`Respuesta de ${spec.method.toUpperCase()} ${spec.path} no cumple su esquema: ${r.error.message}`);
      }
      return c.json(redactDeep(result), (spec.status ?? 200) as ContentfulStatusCode);
    });
  }

  /** Ruta con manejador propio (WebSocket). Se documenta igual. */
  addRaw(spec: RouteSpec, ...handlers: MiddlewareHandler[]): void {
    this.specs.push(spec);
    this.app.on(spec.method.toUpperCase(), [spec.path], ...handlers);
  }
}
