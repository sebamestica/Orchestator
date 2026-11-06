import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../../src/core/app/compose.ts';
import { startCore, type Core } from '../../../src/core/main.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { taskBriefSchema, type AgentAdapter, type AgentConfig, type AgentEvent, type ProbeResult, type RunContext, type TaskBrief } from '../../../src/shared/index.ts';
import { cleanupDirs, tempDir } from './helpers.ts';

const KEY_A = `sk-ant-api03-${'a'.repeat(48)}`;
const KEY_B = `sk-ant-api03-${'b'.repeat(48)}`;
const KEY_NEW = `sk-ant-api03-${'n'.repeat(48)}`;

const cores: Core[] = [];
const comps: Composition[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const c of comps.splice(0)) await c.shutdown();
  await cleanupDirs();
});

/** Ejecución anotada por el agente falso: quién corrió qué y si recibió la clave nueva (sin guardar la clave). */
interface Run {
  agentId: string;
  taskId: string;
  newKey: boolean;
}

/** Agente falso: como autor escribe su primera ruta propia; como revisor aprueba en JSON. */
function workerAdapter(config: AgentConfig, runs: Run[]): AgentAdapter {
  return {
    config,
    async probe(): Promise<ProbeResult> {
      return { agentId: config.id, installed: true, authenticated: true, models: [], quotaMethod: 'none', warnings: [] };
    },
    async *run(t: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent> {
      runs.push({ agentId: config.id, taskId: t.id, newKey: ctx.env.ANTHROPIC_API_KEY === KEY_NEW });
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

/** Núcleo real con dos Claude (`claude`, `claude-b`) y Codex, falsos pero pasando por la flota de verdad. */
async function setup() {
  const root = await tempDir('orq-flota-agentes-');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@local', ...args], { cwd: repo, encoding: 'utf8' });
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'inicio']]) expect(git(...args).status).toBe(0);

  const runs: Run[] = [];
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
  await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: KEY_A, displayName: 'Claude', id: 'claude' });
  await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: KEY_B, displayName: 'Claude B', id: 'claude-b' });
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
  const finish = async (id: string): Promise<string> => {
    let state = '';
    for (let i = 0; i < 400 && !['integrated', 'failed'].includes(state); i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = String(((await call('GET', `/tasks/${id}`)).json.task as { state: string }).state);
    }
    return state;
  };
  let n = 0;
  /** Tarea manual (dificultad media), aprobada al crearla; espera a que termine. */
  const manual = async (agentId?: string): Promise<{ id: string; state: string }> => {
    n++;
    const res = await call('POST', '/tasks/manual', {
      projectId: 'demo',
      title: `Tarea ${n}`,
      objective: `Crear src/t${n}.mjs`,
      ownedPaths: [`src/t${n}.mjs`],
      ...(agentId ? { agentId } : {}),
    });
    expect(res.status).toBe(201);
    const id = (res.json.task as { task: { id: string } }).task.id;
    return { id, state: await finish(id) };
  };
  /** Tarea de dificultad alta aprobada para `agentId`; espera a que termine. */
  const high = async (agentId: string): Promise<{ id: string; state: string }> => {
    n++;
    const brief = taskBriefSchema.parse({
      id: `alta-${n}`,
      projectId: 'demo',
      title: `Alta ${n}`,
      objective: `Crear src/alta${n}.mjs`,
      ownedPaths: [`src/alta${n}.mjs`],
      dependsOn: [],
      acceptance: ['listo'],
      difficulty: 'high',
      contextRefs: [],
      skillRefs: [],
    });
    comp.store.putTask(brief);
    expect((await call('POST', `/tasks/${brief.id}/approve`, { agentId })).status).toBe(200);
    return { id: brief.id, state: await finish(brief.id) };
  };
  const authorsOf = (taskId: string) => runs.filter((r) => r.taskId === taskId).map((r) => r.agentId);

  expect((await call('POST', '/projects', { id: 'demo', name: 'Demo', repoPath: repo })).status).toBe(201);
  // La primera tarea arma la flota: lo que sigue ocurre con la flota ya armada.
  const first = await manual('codex');
  expect(first.state).toBe('integrated');
  expect(authorsOf(first.id)).toEqual(['codex']);
  return { comp, call, manual, high, runs, authorsOf };
}

describe('la flota ya armada ve los cambios de agentes sin reiniciar el núcleo', () => {
  it('deshabilitar Codex: la tarea fijada a Codex la corre otro agente', async () => {
    const { call, manual, runs } = await setup();
    expect((await call('PATCH', '/agents/codex', { enabled: false })).status).toBe(200);
    const t = await manual('codex');
    expect(t.state).toBe('integrated');
    expect(runs.filter((r) => r.taskId.startsWith(t.id)).map((r) => r.agentId)).not.toContain('codex');
  }, 60_000);

  it('un agente agregado después cuenta para la flota y para los subagentes de Ajustes', async () => {
    const { call, manual, authorsOf } = await setup();
    expect((await call('POST', '/agents', { id: 'codex2', kind: 'codex-cli', provider: 'codex', displayName: 'Codex 2' })).status).toBe(201);
    expect((await call('PATCH', '/settings', { workers: ['codex2'] })).status).toBe(200);
    const t = await manual();
    expect(t.state).toBe('integrated');
    expect(authorsOf(t.id)).toEqual(['codex2']);
  }, 60_000);

  it('borrar Claude y volver a agregarlo con otra clave: la siguiente tarea usa la clave nueva', async () => {
    const { call, high, runs } = await setup();
    expect((await call('DELETE', '/agents/claude')).status).toBe(200);
    expect((await call('POST', '/agents', { provider: 'anthropic', apiKey: KEY_NEW, displayName: 'Claude', id: 'claude' })).status).toBe(201);
    const t = await high('claude');
    expect(t.state).toBe('integrated');
    const author = runs.filter((r) => r.taskId === t.id);
    expect(author.map((r) => r.agentId)).toEqual(['claude']);
    expect(author[0]?.newKey).toBe(true);
  }, 60_000);

  it('borrar Codex: la siguiente tarea no la recibe Codex', async () => {
    const { call, manual, runs } = await setup();
    expect((await call('DELETE', '/agents/codex')).status).toBe(200);
    const t = await manual();
    expect(t.state).toBe('integrated');
    expect(runs.filter((r) => r.taskId.startsWith(t.id)).map((r) => r.agentId)).not.toContain('codex');
  }, 60_000);
});
