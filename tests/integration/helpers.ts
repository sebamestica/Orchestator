import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentConfig, AgentEvent, ProbeResult, RunContext, TaskBrief } from '../../src/shared/index.ts';
import { taskBriefSchema } from '../../src/shared/index.ts';

/** Clave falsa con forma real, distinta en cada ejecución (nunca una clave de verdad). */
export function fakeKey(tag = ''): string {
  return `sk-ant-api03-${tag}${randomBytes(24).toString('hex')}`;
}

/** Servidor intermedio del usuario (la URL no es secreta; la clave sí). */
export const USER_BASE_URL = 'http://203.0.113.7:18082';

/** Respuesta real de `GET /v1/models` del servidor del usuario (fixture de c1, sin claves). */
export const MODELS_JSON = readFileSync(fileURLToPath(new URL('../../fixtures/claude-sdk/models-list.json', import.meta.url)), 'utf8');

export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

export function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `fetch` falso que registra cada llamada (URL, método, cabeceras y cuerpo). */
export function mockFetch(route: (call: FetchCall) => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const call: FetchCall = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    return route(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Respuesta de `POST /v1/messages` con el texto indicado (forma de la API de Mensajes). */
export function messageResponse(text: string, model = 'claude-opus-5-5'): Response {
  return json({
    id: 'msg_prueba',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

/** Rutas del servidor de Anthropic falso: modelos (probe) y mensajes (planificador). */
export function anthropicRoutes(planText: string): (call: FetchCall) => Response {
  return (call) => {
    if (call.method === 'GET' && call.url.includes('/v1/models')) return json(MODELS_JSON);
    if (call.method === 'POST' && call.url.endsWith('/v1/messages')) return messageResponse(planText);
    return json({ type: 'error', error: { type: 'not_found_error', message: 'ruta' } }, 404);
  };
}

/** Adaptador falso: registra el entorno recibido y emite un texto que intenta filtrar la clave. */
export function leakyAdapter(config: AgentConfig, seen: { agentId: string; env: Readonly<Record<string, string>> }[]): AgentAdapter {
  return {
    config,
    async probe(): Promise<ProbeResult> {
      return { agentId: config.id, installed: true, authenticated: true, models: [], quotaMethod: 'manual-budget', warnings: [] };
    },
    async *run(_task: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent> {
      seen.push({ agentId: config.id, env: ctx.env });
      const base = { sessionId: `s-${config.id}`, agentId: config.id, ts: new Date().toISOString() };
      const key = ctx.env.ANTHROPIC_API_KEY ?? 'sin-clave';
      yield { ...base, seq: 0, type: 'text', payload: { role: 'assistant', text: `OK, mi clave es ${key}` } };
      yield { ...base, seq: 1, type: 'usage', payload: { inputTokens: 10, outputTokens: 2, costUsd: 0.001, model: 'claude-opus-5-5' } };
      yield { ...base, seq: 2, type: 'done', payload: { ok: true } };
    },
  };
}

export function okTask(id = 'probar-ok'): TaskBrief {
  return taskBriefSchema.parse({
    id,
    projectId: 'orquestador',
    title: 'Responder OK',
    objective: 'Responde exactamente: OK',
    ownedPaths: ['(ninguna)'],
    dependsOn: [],
    acceptance: ['Responde OK'],
    difficulty: 'low',
  });
}

/** Plan JSON válido para `planToTasks`. */
export function planJson(projectId: string): string {
  return JSON.stringify([
    { id: 'tarea-a', projectId, title: 'A', objective: 'Hacer A', ownedPaths: ['src/a/**'], dependsOn: [], acceptance: ['npm test'], difficulty: 'low' },
    { id: 'tarea-b', projectId, title: 'B', objective: 'Hacer B', ownedPaths: ['src/b/**'], dependsOn: ['tarea-a'], acceptance: ['npm test'], difficulty: 'medium' },
  ]);
}

const dirs: string[] = [];

export async function tempDir(prefix = 'orq-c12-'): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export async function cleanupDirs(): Promise<void> {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
