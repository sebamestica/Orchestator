/** Cableado del chat (f5-chat.ts) sobre la composición real: bóveda, registro, flota, tablero y traductor de c1. */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../../src/core/app/compose.ts';
import { chatRouteModule, lazyFleetPort, type ChatWiring } from '../../../src/core/app/f5-chat.ts';
import { ROUTE_MODULE_FACTORIES } from '../../../src/core/app/route-modules.ts';
import type { ChatService } from '../../../src/core/chat/index.ts';
import { CHROME_TAB_NOTE, NO_BROWSER_NOTE, PluginStateStore } from '../../../src/core/plugins/index.ts';
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

async function setup(extra: { real?: boolean } = {}) {
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
  const wiring: ChatWiring = {
    query: q.fn,
    settings: () => ({ ...DEFAULT_SETTINGS, mind: { agentId: null, effort: 'max' } }),
    // `real`: sin `mcpServersFor` inyectado, los plugins salen de `comp.plugins` (como en producción).
    ...(extra.real
      ? {}
      : {
          mcpServersFor: (agentId: string) => {
            asked.push(agentId);
            return {};
          },
        }),
    drives: () => ['C:\\'],
    onReady: (s) => services.push(s),
  };
  const core = createApp({
    token,
    allowedHosts: () => [HOST],
    store: comp.store,
    registry,
    hub,
    validateResponses: true,
    routeModules: [chatRouteModule(comp, wiring)],
  });
  const call = async (method: string, path: string, body?: unknown) =>
    core.app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { dir, comp, q, key, call, asked };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Marca Chrome conectado en la base (el lanzador por defecto no se ejecuta: solo se arma su comando). */
function chromeConnected(comp: Composition): void {
  new PluginStateStore(comp.store.database).put({ id: 'chrome', status: 'connected', agents: [], steps: [], profile: 'personal', updatedAt: new Date().toISOString() });
}

async function say(s: Setup, chatId: string, text: string): Promise<void> {
  expect((await s.call('POST', `/chats/${chatId}/messages`, { text })).status).toBe(201);
  for (let i = 0; i < 200 && services[0]?.get(chatId).state === 'running'; i++) await tick();
}

type Guard = (...a: unknown[]) => Promise<unknown>;
const guardOf = (o: Options | undefined) => (o?.hooks?.PreToolUse as { hooks: Guard[] }[] | undefined)?.[0]?.hooks[0];

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

  it('desconectar Chrome en Plugins se lo quita a la sesión viva de la mente (y conectarlo se lo da)', async () => {
    const s = await setup({ real: true });
    chromeConnected(s.comp);
    const { chat } = (await (await s.call('POST', '/chats', { projectId: 'demo' })).json()) as { chat: Chat };
    await say(s, chat.id, 'lista mis pestañas');
    const first = s.q.calls[0]?.options as Options;
    expect(Object.keys(first.mcpServers ?? {})).toContain('chrome-personal');
    expect(first.allowedTools).toContain('mcp__chrome-personal__*');
    // Con las reglas de la flota: pestaña propia, sin contraseñas, nunca otro navegador.
    const rulesOf = (o: Options) => (o.systemPrompt as string[]).join('\n');
    expect(rulesOf(first)).toContain(CHROME_TAB_NOTE);
    expect(rulesOf(first)).toContain('no escribas contraseñas');
    expect(rulesOf(first)).not.toContain(NO_BROWSER_NOTE);

    await s.comp.plugins.disconnect('chrome');
    // La sesión vieja deja de usarlo en el acto (p. ej. un subagente que sigue trabajando).
    const deny = JSON.stringify(await guardOf(first)?.({ hook_event_name: 'PreToolUse', tool_name: 'mcp__chrome-personal__list_pages', tool_input: {}, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: s.dir }, 't', { signal: new AbortController().signal }));
    expect(deny).toMatch(/deny/);
    await say(s, chat.id, 'lista mis pestañas otra vez');
    expect(s.q.calls).toHaveLength(2);
    const second = s.q.calls[1]?.options as Options;
    expect(Object.keys(second.mcpServers ?? {})).not.toContain('chrome-personal');
    expect(second.allowedTools).not.toContain('mcp__chrome-personal__*');
    expect(second.resume).toBe('sdk-1');
    expect(rulesOf(second)).toContain(NO_BROWSER_NOTE);
    expect(rulesOf(second)).not.toContain(CHROME_TAB_NOTE);

    // Al revés: conectarlo con el chat abierto lo entrega en el mensaje siguiente.
    chromeConnected(s.comp);
    await say(s, chat.id, 'y ahora');
    expect(s.q.calls).toHaveLength(3);
    expect(Object.keys(s.q.calls[2]?.options.mcpServers ?? {})).toContain('chrome-personal');
  });
});
