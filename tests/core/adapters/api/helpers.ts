import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchFn } from '../../../../src/core/adapters/api/index.ts';
import {
  agentConfigSchema,
  agentEventSchema,
  taskBriefSchema,
  type AgentConfig,
  type AgentEvent,
  type Provider,
  type RunContext,
} from '../../../../src/shared/index.ts';

/**
 * Servidor simulado para las pruebas del adaptador de API: responde con las fixtures de `fixtures/api/` a través de
 * un `fetch` inyectado, registra cada llamada y permite transmisiones que quedan colgadas hasta que se aborta la señal.
 */

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/api/', import.meta.url));

export function fixture(path: string): string {
  return readFileSync(`${FIXTURES}${path}`, 'utf8');
}

/** Clave falsa con formato reconocible por `redactSecrets` y otra sin formato (como la del proxy del usuario). */
export const KEY = 'sk-test-SECRETO-1234567890abcdef';
export const PLAIN_KEY = 'clave-proxy-sin-formato-1234';

export interface FakeRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | undefined;
}

export type Responder = (req: FakeRequest, attempt: number) => Response | Promise<Response>;

export interface FakeRoute {
  method?: string;
  /** Se compara con la URL completa (incluida la query). */
  url: string | RegExp;
  respond: Responder;
}

export class FakeServer {
  readonly calls: FakeRequest[] = [];
  readonly #routes: FakeRoute[];

  constructor(routes: FakeRoute[]) {
    this.#routes = routes;
  }

  callsTo(url: string | RegExp): FakeRequest[] {
    return this.calls.filter((c) => matches(url, c.url));
  }

  readonly fetch: FetchFn = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const request = input instanceof Request ? input : undefined;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const rawBody = init?.body;
    let body: unknown = undefined;
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const signal = init?.signal ?? request?.signal ?? undefined;
    const req: FakeRequest = { url, method, headers, body, signal };
    this.calls.push(req);
    const route = this.#routes.find((r) => (r.method ?? 'GET') === method && matches(r.url, url));
    if (!route) return jsonResponse({ error: { message: `ruta no simulada: ${method} ${url}` } }, 404);
    const attempt = this.calls.filter((c) => c.method === method && matches(route.url, c.url)).length;
    return route.respond(req, attempt);
  }) as FetchFn;
}

function matches(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === 'string' ? url === pattern || url.split('?')[0] === pattern : pattern.test(url);
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function sseResponse(text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** Transmisión que envía `prefix` y luego queda abierta hasta que se aborta la señal de la solicitud. */
export function hangingSse(prefix: string, signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) controller.enqueue(encoder.encode(prefix));
      const abort = () => {
        try {
          controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        } catch {
          /* ya cerrado */
        }
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Primeros eventos SSE de una fixture (hasta e incluyendo el bloque `n`), para cortar la transmisión a mitad. */
export function sseHead(text: string, blocks: number): string {
  return `${text.split(/\n\n/).slice(0, blocks).join('\n\n')}\n\n`;
}

export function makeConfig(provider: Provider, extra: Partial<AgentConfig> = {}): AgentConfig {
  return agentConfigSchema.parse({
    id: `api-${provider}`,
    kind: 'api',
    provider,
    displayName: `API ${provider}`,
    ...extra,
  });
}

export const task = taskBriefSchema.parse({
  id: 't-api-chat',
  projectId: 'orquestador',
  title: 'Prueba del adaptador de API',
  objective: 'Responde exactamente: OK',
  ownedPaths: ['src/core/adapters/api/'],
  dependsOn: [],
  acceptance: ['La respuesta es OK'],
  difficulty: 'low',
});

export function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    worktreePath: process.cwd(),
    env: { ORQ_API_KEY: KEY },
    signal: new AbortController().signal,
    timeoutMs: 15_000,
    ...overrides,
  };
}

/** Recorre la ejecución validando cada evento contra el contrato. */
export async function collect(events: AsyncIterable<AgentEvent>, onEvent?: (e: AgentEvent) => void): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) {
    agentEventSchema.parse(event);
    out.push(event);
    onEvent?.(event);
  }
  return out;
}

export function textOf(events: readonly AgentEvent[], role: 'assistant' | 'thinking-summary' = 'assistant'): string {
  return events
    .map((e) => (e.type === 'text' && e.payload.role === role ? e.payload.text : ''))
    .join('');
}

export function ofType<T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

/** Cabeceras de límite al estilo OpenAI (documentadas en platform.openai.com/docs/guides/rate-limits). */
export const OPENAI_LIMIT_HEADERS: Record<string, string> = {
  'x-ratelimit-limit-requests': '5000',
  'x-ratelimit-remaining-requests': '4999',
  'x-ratelimit-reset-requests': '12ms',
  'x-ratelimit-limit-tokens': '2000000',
  'x-ratelimit-remaining-tokens': '1999500',
  'x-ratelimit-reset-tokens': '15ms',
};

/** Cabeceras de límite de Anthropic (docs.claude.com/en/api/rate-limits). */
export const ANTHROPIC_LIMIT_HEADERS: Record<string, string> = {
  'anthropic-ratelimit-requests-limit': '50',
  'anthropic-ratelimit-requests-remaining': '49',
  'anthropic-ratelimit-requests-reset': '2026-11-01T12:00:30Z',
  'anthropic-ratelimit-tokens-limit': '100000',
  'anthropic-ratelimit-tokens-remaining': '99000',
  'anthropic-ratelimit-tokens-reset': '2026-11-01T12:00:30Z',
};
