/** Cableado del chat (f5-chat.ts) sobre la composición real: bóveda, registro, flota, tablero y traductor de c1. */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../../src/core/app/compose.ts';
import { chatRouteModule, lazyFleetPort } from '../../../src/core/app/f5-chat.ts';
import { ROUTE_MODULE_FACTORIES } from '../../../src/core/app/route-modules.ts';
import type { ChatService } from '../../../src/core/chat/index.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken } from '../../../src/core/server/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { DEFAULT_SETTINGS } from '../../../src/shared/index.ts';
import type { Chat } from '../../../src/shared/index.ts';
import { USER_BASE_URL, anthropicRoutes, cleanupDirs, fakeKey, mockFetch, planJson, tempDir } from '../../integration/helpers.ts';
import { chatQuery, echoTurn, settleChat } from './helpers.ts';

const HOST = '127.0.0.1:47998';
const HOST_KEY = fakeKey('anfitrion');
const comps: Composition[] = [];
const services: ChatService[] = [];
/** El servicio del chat que la composición entregó por `onReady`. */
const mind = (): ChatService => {
  const service = services[0];
  if (!service) throw new Error('la composición no entregó el servicio del chat');
  return service;
};

afterEach(async () => {
  for (const s of services.splice(0)) s.shutdown();
  for (const c of comps.splice(0)) c.close();
  await cleanupDirs();
});

async function setup() {
  const dir = await tempDir();
  const net = mockFetch(anthropicRoutes(planJson('demo')));
  const comp = compose({
    env: { ORQ_DATA_DIR: dir },
    config: { port: 0, quotaRefreshMs: 0 },
    vault: new MemoryVault(),
    memoryDir: `${dir}/memoria`,
    skillsHubDir: `${dir}/hub`,
    projectDir: dir,
    detectors: [],
    anthropicFetch: net.fetch,
    hostEnv: () => ({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: HOST_KEY }),
    claude: { sdkVersion: '0.3.302' },
    routeModules: false,
  });
  comps.push(comp);
  const key = fakeKey();
  await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude', budgetUsd: 2 });
  comp.store.putProject({ id: 'demo', name: 'Demo', repoPath: dir });
  const q = chatQuery(echoTurn);
  const token = generateToken();
  const hub = new EventHub(comp.store);
  const registry = new AgentRegistry({ store: comp.store, vault: comp.vault, detectors: [] });
  const asked: string[] = [];
  const core = createApp({
    token,
    allowedHosts: () => [HOST],
    store: comp.store,
    registry,
    hub,
    validateResponses: true,
    routeModules: [
      chatRouteModule(comp, {
        query: q.fn,
        settings: () => ({ ...DEFAULT_SETTINGS, mind: { agentId: null, effort: 'max' } }),
        mcpServersFor: (agentId) => {
          asked.push(agentId);
          return {};
        },
        drives: () => ['C:\\'],
        onReady: (s) => services.push(s),
      }),
    ],
  });
  const call = async (method: string, path: string, body?: unknown) =>
    core.app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { dir, comp, q, key, call, asked };
}

describe('f5-chat: cableado con la composición', () => {
  it('la línea de c15 está en ROUTE_MODULE_FACTORIES', () => {
    expect(ROUTE_MODULE_FACTORIES.length).toBeGreaterThanOrEqual(1);
  });

  it('la mente usa la clave de la bóveda, sin credenciales del anfitrión, y no lee la bóveda ni la base de datos', async () => {
    const { dir, comp, q, key, call, asked } = await setup();
    const { chat } = (await (await call('POST', '/chats', { projectId: 'demo' })).json()) as { chat: Chat };
    expect(chat.mindAgentId).toBe('claude');
    expect((await call('POST', `/chats/${chat.id}/messages`, { text: 'hola' })).status).toBe(201);
    await settleChat(mind(), chat.id);
    const o = q.calls[0]?.options as Options;
    expect(o.env?.ANTHROPIC_API_KEY).toBe(key);
    expect(o.env?.ANTHROPIC_BASE_URL).toBe(USER_BASE_URL);
    expect(JSON.stringify(o.env)).not.toContain(HOST_KEY);
    expect(o.effort).toBe('max');
    // Tope de la conversación: lo que queda del presupuesto del agente (2 USD, nada gastado).
    expect(o.maxBudgetUsd).toBe(2);
    // Se consulta al calcular la clave y otra vez tras cargar el entorno (que refresca la caché de plugins).
    expect(new Set(asked)).toEqual(new Set(['claude']));
    const session = services[0]?.sessionOf(chat.id);
    expect(session).toBeDefined();
    const pre = (o.hooks?.PreToolUse as { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[])[0]?.hooks[0];
    const read = async (file: string) =>
      JSON.stringify(await pre?.({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: dir }, 't', { signal: new AbortController().signal }));
    expect(await read(comp.config.vaultPath)).toMatch(/deny/);
    expect(await read(comp.config.dbPath)).toMatch(/deny/);
    expect(await read(`${dir}/AGENTS.md`)).toBe('{}');
    // El gasto de la mente queda en SQLite como el del orquestador.
    expect(comp.spentUsd('orquestador')).toBeCloseTo(0.01, 9);
  });

  it('aprobar en el chat lleva la tarea al tablero y a la cola real de la flota', async () => {
    const { comp, call } = await setup();
    const { chat } = (await (await call('POST', '/chats', { projectId: 'demo' })).json()) as { chat: Chat };
    await call('POST', `/chats/${chat.id}/messages`, { text: 'plan' });
    await settleChat(mind(), chat.id);
    // crear_tareas → planToTasks (c2) con la clave de la bóveda contra el servidor falso.
    const created = await services[0]?.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: '1. A\n2. B' });
    expect(created?.isError).toBeFalsy();
    const res = (await (await call('POST', `/chats/${chat.id}/proposals/tarea-a/approve`)).json()) as { delivered: string[] };
    expect(res.delivered).toEqual(['tarea-a']);
    expect(comp.fleet.queue.get('tarea-a')).toBeDefined();
    expect(comp.store.getTask('tarea-a')).toBeDefined();
    expect((await lazyFleetPort(comp).status('tarea-a'))?.taskId).toBe('tarea-a');
  });
});
