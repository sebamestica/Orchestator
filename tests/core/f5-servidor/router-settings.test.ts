import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../../src/core/app/compose.ts';
import { FleetService } from '../../../src/core/app/fleet-service.ts';
import { startCore, type Core } from '../../../src/core/main.ts';
import { Router, RoutingError, type RouterSettings } from '../../../src/core/orchestrator/router.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { DEFAULT_SETTINGS, type AgentAdapter, type AgentConfig, type AgentEvent, type ProbeResult, type RunContext, type Settings, type TaskBrief } from '../../../src/shared/index.ts';
import { agents, FakeQuota, task } from '../orchestrator/fakes.ts';
import { cleanupDirs, tempDir } from './helpers.ts';

const all = [agents.claude1, agents.claude2, agents.codex, agents.agy];

function withSettings(initial: Partial<RouterSettings>): { settings: RouterSettings; get: () => RouterSettings } {
  const settings: RouterSettings = { workers: [], quotaFloor: 0.2, ...initial };
  return { settings, get: () => settings };
}

describe('Router con ajustes: subagentes (workers)', () => {
  it('solo asigna autores entre los workers; vacío = todos', async () => {
    const s = withSettings({ workers: ['claude-2'] });
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.9)], settings: s.get });
    for (let i = 0; i < 4; i++) {
      const d = await router.route(task(`tarea-${i}`));
      expect(d.agentId).toBe('claude-2');
    }
    s.settings.workers = [];
    expect((await router.route(task('libre'))).agentId).toBe('codex');
  });

  it('un agente sugerido fuera de los workers se ignora con aviso', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.9)], settings: withSettings({ workers: ['agy', 'claude-1'] }).get });
    const d = await router.route(task('sugerida', { suggestedAgent: 'codex' }));
    expect(d.agentId).toBe('agy');
    expect(d.warnings.join(' ')).toMatch(/codex no está entre los subagentes elegidos en Ajustes/);
  });

  it('dificultad alta sin Claude entre los workers → RoutingError que lo explica', async () => {
    const router = new Router({ agents: all, settings: withSettings({ workers: ['codex', 'agy'] }).get });
    await expect(router.route(task('dura', { difficulty: 'high' }))).rejects.toThrow(/entre los subagentes elegidos en Ajustes \(codex, agy\)/);
    await expect(router.route(task('dura2', { difficulty: 'high' }))).rejects.toThrow(RoutingError);
  });

  it('workers sin Claude y todos ocupados: el elegido con cupo recibe la tarea en vez de fallar', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9)], settings: withSettings({ workers: ['codex'] }).get });
    expect((await router.route(task('tarea-a'))).agentId).toBe('codex');
    const second = await router.route(task('tarea-b'));
    expect(second.agentId).toBe('codex');
    expect(second.warnings.join(' ')).toMatch(/único subagente elegido en Ajustes con cupo/);
  });

  it('workers sin Claude y sin cupo: RoutingError (no se usa a Claude a escondidas)', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.05)], settings: withSettings({ workers: ['codex'] }).get });
    await expect(router.route(task('tarea-a'))).rejects.toThrow(/No hay instancias de Claude disponibles entre los subagentes elegidos/);
  });

  it('ids desconocidos se ignoran; si no queda ninguno, sin restricción', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9)], settings: withSettings({ workers: ['borrado', 'claude-1'] }).get });
    expect((await router.route(task('tarea-a'))).agentId).toBe('claude-1');
    const free = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9)], settings: withSettings({ workers: ['borrado'] }).get });
    expect((await free.route(task('tarea-b'))).agentId).toBe('codex');
  });

  it('la revisión prefiere a los workers y, si ninguno sirve, revisa otro agente habilitado (con aviso)', async () => {
    const preferred = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.9)], settings: withSettings({ workers: ['claude-1', 'agy'] }).get });
    expect((await preferred.chooseReviewer(task('tarea-r'), 'claude-1')).agentId).toBe('agy');

    const only = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.9)], settings: withSettings({ workers: ['claude-1'] }).get });
    const r = await only.chooseReviewer(task('tarea-r'), 'claude-1');
    expect(r.agentId).not.toBe('claude-1');
    expect(r.warnings.join(' ')).toMatch(/Ningún subagente elegido en Ajustes puede revisar tarea-r/);
  });

  it('los rescates (pickClaude) prefieren un Claude elegido y, si no hay, continúa otro Claude con aviso', () => {
    const preferred = new Router({ agents: all, settings: withSettings({ workers: ['claude-2', 'codex'] }).get });
    expect(preferred.pickClaude().agentId).toBe('claude-2');
    const none = new Router({ agents: all, settings: withSettings({ workers: ['codex'] }).get });
    const d = none.pickClaude();
    expect(['claude-1', 'claude-2']).toContain(d.agentId);
    expect(d.warnings.join(' ')).toMatch(/Ningún Claude está entre los subagentes elegidos/);
  });
});

describe('Router con ajustes: umbral de cupo', () => {
  it('settings.quotaFloor manda sobre el quotaFloor de cada agente y se lee en cada decisión', async () => {
    const s = withSettings({ quotaFloor: 0.5 });
    const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.4)], settings: s.get });
    expect(await router.checkQuota('codex')).toMatchObject({ allowed: false, floor: 0.5 });
    expect((await router.route(task('tarea-a'))).agentId).toBe('claude-1');
    s.settings.quotaFloor = 0.1;
    expect(await router.checkQuota('codex')).toMatchObject({ allowed: true, floor: 0.1 });
    // Sin ajustes, el piso del agente (0,2 por defecto).
    const bare = new Router({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.4)], settings: () => undefined });
    expect(await bare.checkQuota('codex')).toMatchObject({ allowed: true, floor: 0.2 });
  });
});

describe('FleetService con ajustes', () => {
  it('toma la concurrencia de los ajustes al conectarlos y al cambiar', () => {
    const store = new SqliteStore({ path: ':memory:' });
    try {
      const deps = { store } as unknown as ConstructorParameters<typeof FleetService>[0];
      const fleet = new FleetService(deps, {} as ConstructorParameters<typeof FleetService>[1], { concurrency: 3 });
      expect(fleet.queue.concurrency).toBe(3);
      let current: Settings = { ...DEFAULT_SETTINGS, concurrency: 1 };
      fleet.useSettings(() => current);
      expect(fleet.queue.concurrency).toBe(1);
      current = { ...current, concurrency: 6 };
      fleet.settingsChanged();
      expect(fleet.queue.concurrency).toBe(6);
      // Unos ajustes que fallan al leerse no cambian nada.
      fleet.useSettings(() => {
        throw new Error('base cerrada');
      });
      expect(fleet.queue.concurrency).toBe(6);
    } finally {
      store.close();
    }
  });
});

// ------------------------------------------------------------------ de punta a punta

const cores: Core[] = [];
const comps: Composition[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const c of comps.splice(0)) await c.shutdown();
  await cleanupDirs();
});

/** Agente falso: como autor escribe su primera ruta propia; como revisor aprueba en JSON. */
function workerAdapter(config: AgentConfig, runs: string[]): AgentAdapter {
  return {
    config,
    async probe(): Promise<ProbeResult> {
      return { agentId: config.id, installed: true, authenticated: true, models: [], quotaMethod: 'none', warnings: [] };
    },
    async *run(t: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent> {
      runs.push(`${config.id}:${t.id}`);
      const base = { sessionId: `${config.id}-${t.id}`, agentId: config.id, ts: new Date().toISOString() };
      let text = '{"veredicto":"aprobado","observaciones":[]}';
      if (!t.id.endsWith('-revision')) {
        const rel = t.ownedPaths[0] ?? 'x.txt';
        mkdirSync(join(ctx.worktreePath, rel, '..'), { recursive: true });
        writeFileSync(join(ctx.worktreePath, rel), `// hecho por ${config.id}\n`);
        text = 'Listo.';
      }
      yield { ...base, seq: 0, type: 'text', payload: { role: 'assistant', text } };
      yield { ...base, seq: 1, type: 'done', payload: { ok: true } };
    },
  };
}

describe('compose + f5Servidor: la flota respeta los ajustes', () => {
  it('PATCH /settings cambia la concurrencia de la cola y los workers deciden el autor', async () => {
    const root = await tempDir('orq-c14-flota-');
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@local', ...args], { cwd: repo, encoding: 'utf8' });
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'inicio']]) expect(git(...args).status).toBe(0);

    const runs: string[] = [];
    const comp = compose({
      env: { ORQ_DATA_DIR: join(root, 'datos'), ORQ_UI_DIR: join(root, 'ui') },
      config: { port: 0, quotaRefreshMs: 0 },
      vault: new MemoryVault(),
      memoryDir: join(root, 'memoria'),
      skillsHubDir: join(root, 'hub'),
      detectors: [],
      hostEnv: () => ({}),
      workspaceProjects: [{ id: 'demo', repoPath: repo, worktreesRoot: join(root, 'wt'), gate: [{ command: process.execPath, args: ['--version'] }] }],
      constructors: { claudeSdk: (o) => workerAdapter(o.config, runs), codexCli: (c) => workerAdapter(c, runs) },
    });
    comps.push(comp);
    await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: `sk-ant-api03-${'f'.repeat(48)}`, displayName: 'Claude', id: 'claude' });
    comp.registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
    const core = await startCore(comp.deps);
    cores.push(core);
    comp.fleet.attachSink(core.hub);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${core.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${core.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };

    // La interfaz (sin compilar en ORQ_UI_DIR) responde 404 sin token; la API sigue pidiéndolo.
    expect((await fetch(`${core.url}/`)).status).toBe(404);
    expect((await fetch(`${core.url}/settings`)).status).toBe(401);

    expect(comp.fleet.queue.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect((await call('PATCH', '/settings', { concurrency: 2, workers: ['claude'] })).status).toBe(200);
    expect(comp.fleet.queue.concurrency).toBe(2);

    expect((await call('POST', '/projects', { id: 'demo', name: 'Demo', repoPath: repo })).status).toBe(201);
    // Sugerida a Codex y de dificultad media: sin ajustes iría a Codex; con workers = [claude], la hace Claude.
    const res = await call('POST', '/tasks/manual', { projectId: 'demo', title: 'Uno', objective: 'Crear src/uno.mjs', ownedPaths: ['src/uno.mjs'], agentId: 'codex' });
    expect(res.status).toBe(201);
    const id = (res.json.task as { task: { id: string } }).task.id;
    let state = '';
    for (let i = 0; i < 300 && !['integrated', 'failed'].includes(state); i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = String(((await call('GET', `/tasks/${id}`)).json.task as { state: string }).state);
    }
    expect(state).toBe('integrated');
    // Autor Claude (el único worker); la revisión, que no puede ser del autor, la hace Codex con aviso.
    expect(runs).toEqual([`claude:${id}`, `codex:${id}-revision`]);
    expect(git('show', 'orq/integracion:src/uno.mjs').stdout).toBe('// hecho por claude\n');
  }, 60_000);
});
