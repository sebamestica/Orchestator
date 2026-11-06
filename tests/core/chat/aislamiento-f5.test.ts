/**
 * Issue 9 sobre el cableado real del chat (f5-chat.ts + composición): la mente de un proyecto no ve la cola, la
 * memoria ni las skills de otro proyecto. Ver docs/plan/issues/09-aislamiento-contexto.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../../src/core/app/compose.ts';
import { chatRouteModule, lazyFleetPort } from '../../../src/core/app/f5-chat.ts';
import type { ChatService } from '../../../src/core/chat/index.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken } from '../../../src/core/server/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { DEFAULT_SETTINGS } from '../../../src/shared/index.ts';
import type { Chat } from '../../../src/shared/index.ts';
import { USER_BASE_URL, anthropicRoutes, cleanupDirs, fakeKey, mockFetch, planJson, tempDir } from '../../integration/helpers.ts';
import { brief, jsonOf, textOf } from '../conductor/fakes.ts';
import { chatQuery, echoTurn, settleChat } from './helpers.ts';

const HOST = '127.0.0.1:47997';
const comps: Composition[] = [];
const services: ChatService[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) s.shutdown();
  for (const c of comps.splice(0)) c.close();
  await cleanupDirs();
});

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`;

/**
 * Dos proyectos (`demo` y `otro`) en carpetas hermanas, la memoria de Obsidian aparte y el núcleo arrancado en otra
 * carpeta (`nucleo`, como `C:\dev\orquestador` en el escritorio) que trae sus propias skills.
 */
async function setup() {
  const dir = await tempDir('orq-c27-');
  const demo = path.join(dir, 'demo');
  const otro = path.join(dir, 'otro');
  const nucleo = path.join(dir, 'nucleo');
  for (const d of [demo, otro, path.join(dir, 'hub', 'skills', 'comun'), path.join(nucleo, '.agents', 'skills', 'ajena')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(dir, 'hub', 'skills', 'comun', 'SKILL.md'), skillMd('comun', 'Navegador comun para probar paginas.'));
  await writeFile(path.join(nucleo, '.agents', 'skills', 'ajena', 'SKILL.md'), skillMd('ajena', 'Navegador de otro proyecto.'));
  await writeFile(path.join(demo, 'AGENTS.md'), '# demo\n');
  const net = mockFetch(anthropicRoutes(planJson('demo')));
  const comp = compose({
    env: { ORQ_DATA_DIR: path.join(dir, 'datos') },
    config: { port: 0, quotaRefreshMs: 0 },
    vault: new MemoryVault(),
    memoryDir: path.join(dir, 'memoria'),
    skillsHubDir: path.join(dir, 'hub'),
    projectDir: nucleo,
    detectors: [],
    anthropicFetch: net.fetch,
    hostEnv: () => ({ PATH: 'C:\\Windows' }),
    claude: { sdkVersion: '0.3.302' },
    routeModules: false,
  });
  comps.push(comp);
  await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: fakeKey(), baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude', budgetUsd: 2 });
  comp.store.putProject({ id: 'demo', name: 'Demo', repoPath: demo });
  comp.store.putProject({ id: 'otro', name: 'Otro', repoPath: otro });
  const q = chatQuery(echoTurn);
  const token = generateToken();
  const core = createApp({
    token,
    allowedHosts: () => [HOST],
    store: comp.store,
    registry: new AgentRegistry({ store: comp.store, vault: comp.vault, detectors: [] }),
    hub: new EventHub(comp.store),
    validateResponses: true,
    routeModules: [
      chatRouteModule(comp, {
        query: q.fn,
        settings: () => DEFAULT_SETTINGS,
        mcpServersFor: () => ({}),
        // Modo bypass: la mente lee todas las unidades.
        drives: () => [path.parse(dir).root],
        onReady: (s) => services.push(s),
      }),
    ],
  });
  const call = async (method: string, route: string, body?: unknown) =>
    core.app.request(`http://${HOST}${route}`, {
      method,
      headers: { host: HOST, authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  /** Chat de `demo` en bypass con su sesión ya abierta. */
  const openChat = async () => {
    const { chat } = (await (await call('POST', '/chats', { projectId: 'demo', mode: 'bypass' })).json()) as { chat: Chat };
    expect((await call('POST', `/chats/${chat.id}/messages`, { text: 'hola' })).status).toBe(201);
    const service = services[0];
    if (!service) throw new Error('la composición no entregó el servicio del chat');
    await settleChat(service, chat.id);
    const session = service.sessionOf(chat.id);
    if (!session) throw new Error('sin sesión');
    return { chat, session };
  };
  return { dir, demo, otro, comp, q, openChat };
}

describe('f5-chat: la mente de un proyecto no ve los de otro', () => {
  it('la flota informa el proyecto de cada tarea, desde la cola o desde la base', async () => {
    const { comp } = await setup();
    comp.fleet.queue.add(brief('cola-demo', { projectId: 'demo' }));
    comp.fleet.queue.add(brief('cola-otro', { projectId: 'otro' }));
    comp.store.putTask(brief('vieja-otro', { projectId: 'otro' }), 'failed');
    const port = lazyFleetPort(comp);
    expect((await port.list()).map((s) => [s.taskId, 'projectId' in s ? s.projectId : undefined])).toEqual([
      ['cola-demo', 'demo'],
      ['cola-otro', 'otro'],
    ]);
    expect(await port.status('vieja-otro')).toMatchObject({ taskId: 'vieja-otro', state: 'failed', projectId: 'otro' });
  });

  it('estado del chat de demo no lista ni informa las tareas de otro, aunque estén en la misma cola', async () => {
    const { comp, openChat } = await setup();
    comp.fleet.queue.add(brief('cola-demo', { projectId: 'demo' }));
    comp.fleet.queue.add(brief('cola-otro', { projectId: 'otro' }));
    comp.store.putTask(brief('vieja-otro', { projectId: 'otro' }), 'failed');
    const { session } = await openChat();
    const summary = jsonOf(await session.tools.call('estado', {}));
    expect(summary).toMatchObject({ proyecto: 'demo', total: 1 });
    expect((summary.tareas as { id: string }[]).map((t) => t.id)).toEqual(['cola-demo']);
    for (const taskId of ['cola-otro', 'vieja-otro']) {
      const result = await session.tools.call('estado', { taskId });
      expect(result.isError, taskId).toBe(true);
      expect(textOf(result)).toMatch(/no es de este proyecto \(demo\)/);
    }
  });

  it('leer_memoria trae la de demo; escribir_memoria no toca la de otro', async () => {
    const { comp, openChat } = await setup();
    const at = '2026-11-05T01:00:00.000Z';
    await comp.memory.writeProjectSummary('demo', 'Resumen de demo.', at);
    await comp.memory.writeProjectSummary('otro', 'Plan secreto de otro.', at);
    const { session } = await openChat();
    const read = textOf(await session.tools.call('leer_memoria', {}));
    expect(read).toContain('Resumen de demo.');
    expect(read).not.toContain('Plan secreto de otro.');
    const write = await session.tools.call('escribir_memoria', { proyecto: 'otro', nota: { tipo: 'resumen', texto: 'Pisado desde demo.' } });
    expect(write.isError).toBe(true);
    expect(await comp.memory.projectSummary('otro')).toContain('Plan secreto de otro.');
    expect(await comp.memory.projectSummary('otro')).not.toContain('Pisado desde demo.');
  });

  it('en bypass, ni la mente ni sus subagentes leen la memoria de Obsidian (la de todos los proyectos)', async () => {
    const { demo, comp, q, openChat } = await setup();
    await comp.memory.writeProjectSummary('otro', 'Plan secreto de otro.', '2026-11-05T01:00:00.000Z');
    await openChat();
    const o = q.calls[0]?.options as Options;
    const pre = (o.hooks?.PreToolUse as { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[])[0]?.hooks[0];
    // Los subagentes (investigador) pasan por el mismo hook: `agent_id` no cambia la decisión.
    const use = async (tool_name: string, tool_input: Record<string, unknown>, agent = false) =>
      JSON.stringify(
        await pre?.(
          { hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: demo, ...(agent ? { agent_id: 'investigador-1', agent_type: 'investigador' } : {}) },
          't',
          { signal: new AbortController().signal },
        ),
      );
    const vault = comp.memory.vaultPath;
    const note = path.join(vault, 'Orquestador', 'Proyectos', 'otro', 'Contexto.md');
    // Los mismos usos que tuvo el investigador del chat de marketing (eventos 2811, 2816 y 2824).
    for (const agent of [false, true]) {
      // En bypass la carpeta está dentro de las unidades: lo que la niega es `denyPaths`.
      expect(await use('Read', { file_path: note }, agent)).toMatch(/deny.*credenciales/);
      expect(await use('Glob', { pattern: '**/*.md', path: vault }, agent)).toMatch(/deny.*credenciales/);
      expect(await use('Grep', { pattern: 'marketing|video', path: vault }, agent)).toMatch(/deny.*credenciales/);
      expect(await use('Glob', { pattern: `${vault.replace(/\\/g, '/')}/**/*.md` }, agent)).toMatch(/deny.*credenciales/);
    }
    // El proyecto propio se sigue leyendo.
    expect(await use('Read', { file_path: path.join(demo, 'AGENTS.md') })).toBe('{}');
  });

  it('buscar_skills ofrece las del hub y no las de la carpeta donde arrancó el núcleo', async () => {
    const { comp, openChat } = await setup();
    // La composición sí las ve (es la carpeta del núcleo): la mente no debe recibirlas.
    expect((await comp.skills.list()).map((s) => s.name).sort()).toEqual(['ajena', 'comun']);
    const { session } = await openChat();
    const body = jsonOf(await session.tools.call('buscar_skills', { texto: 'navegador' }));
    expect((body.skills as { nombre: string }[]).map((s) => s.nombre)).toEqual(['comun']);
  });
});
