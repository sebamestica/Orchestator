import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { startCore, type Core } from '../../src/core/main.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import type { AgentAdapter, AgentConfig, AgentEvent, ProbeResult, RunContext, TaskBrief } from '../../src/shared/index.ts';
import { cleanupDirs, fakeKey, tempDir } from './helpers.ts';

const cores: Core[] = [];
const comps: Composition[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const c of comps.splice(0)) await c.shutdown();
  await cleanupDirs();
});

/** Agente falso: como autor escribe su primera ruta propia (sin commit); como revisor aprueba en JSON. */
function workerAdapter(config: AgentConfig, runs: string[]): AgentAdapter {
  return {
    config,
    async probe(): Promise<ProbeResult> {
      return { agentId: config.id, installed: true, authenticated: true, models: [], quotaMethod: 'none', warnings: [] };
    },
    async *run(task: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent> {
      runs.push(`${config.id}:${task.id}`);
      const base = { sessionId: `${config.id}-${task.id}`, agentId: config.id, ts: new Date().toISOString() };
      let text = '{"veredicto":"aprobado","observaciones":[]}';
      if (!task.id.endsWith('-revision')) {
        const rel = task.ownedPaths[0] ?? 'x.txt';
        mkdirSync(join(ctx.worktreePath, rel, '..'), { recursive: true });
        writeFileSync(join(ctx.worktreePath, rel), `// hecho por ${config.id}\n`);
        text = 'Listo.';
      }
      yield { ...base, seq: 0, type: 'text', payload: { role: 'assistant', text } };
      yield { ...base, seq: 1, type: 'usage', payload: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };
      yield { ...base, seq: 2, type: 'done', payload: { ok: true } };
    },
  };
}

describe('servidor → flota real (sin red)', () => {
  it('aprobar una tarea la ejecuta: autor, commit de la flota, revisión de otro agente e integración', async () => {
    const root = await tempDir('orq-hooks-');
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@local', ...args], { cwd: repo, encoding: 'utf8' });
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'inicio'], ['config', 'user.name', 'Usuario Prueba'], ['config', 'user.email', 'usuario@prueba.local']]) {
      expect(git(...args).status).toBe(0);
    }

    const runs: string[] = [];
    const comp = compose({
      env: { ORQ_DATA_DIR: join(root, 'datos') },
      config: { port: 0, quotaRefreshMs: 0 },
      vault: new MemoryVault(),
      memoryDir: join(root, 'memoria'),
      skillsHubDir: join(root, 'hub'),
      detectors: [],
      hostEnv: () => ({}),
      // Sin gate la flota no crea ni integra tareas (c13): uno mínimo que siempre pasa.
      workspaceProjects: [{ id: 'demo', repoPath: repo, worktreesRoot: join(root, 'wt'), gate: [{ command: process.execPath, args: ['--version'] }] }],
      constructors: { claudeSdk: (o) => workerAdapter(o.config, runs), codexCli: (c) => workerAdapter(c, runs) },
    });
    comps.push(comp);
    await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: fakeKey(), displayName: 'Claude', id: 'claude' });
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
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    expect((await call('POST', '/projects', { id: 'demo', name: 'Demo', repoPath: repo })).status).toBe(201);
    const task = { id: 'tarea-uno', projectId: 'demo', title: 'Uno', objective: 'Crear src/uno.mjs', ownedPaths: ['src/uno.mjs'], dependsOn: [], acceptance: ['existe'], difficulty: 'low', suggestedAgent: 'codex' };
    expect((await call('POST', '/tasks', task)).status).toBe(201);
    expect((await call('POST', '/tasks/tarea-uno/approve', {})).status).toBe(200);

    const finalState = async (id: string) => {
      let state = '';
      for (let i = 0; i < 300 && !['integrated', 'failed'].includes(state); i++) {
        await new Promise((r) => setTimeout(r, 50));
        state = String(((await call('GET', `/tasks/${id}`)).json.task as { state: string }).state);
      }
      return state;
    };
    expect(await finalState('tarea-uno')).toBe('integrated');
    expect(runs).toEqual(['codex:tarea-uno', 'claude:tarea-uno-revision']);

    // El agente fijado al aprobar llega a la flota: sin él, una tarea de dificultad baja iría a Codex.
    const dos = { ...task, id: 'tarea-dos', title: 'Dos', objective: 'Crear src/dos.mjs', ownedPaths: ['src/dos.mjs'], suggestedAgent: undefined };
    expect((await call('POST', '/tasks', dos)).status).toBe(201);
    expect((await call('POST', '/tasks/tarea-dos/approve', { agentId: 'claude' })).status).toBe(200);
    expect(await finalState('tarea-dos')).toBe('integrated');
    expect(runs.slice(2)).toEqual(['claude:tarea-dos', 'codex:tarea-dos-revision']);
    expect(git('show', 'orq/integracion:src/dos.mjs').stdout).toBe('// hecho por claude\n');
    expect(git('show', 'orq/integracion:src/uno.mjs').stdout).toBe('// hecho por codex\n');
    // El commit de la flota va a nombre del usuario (su identidad git), sin trailers.
    expect(git('log', '--format=%an <%ae>', 'orq/tarea-uno', '-1').stdout.trim()).toBe('Usuario Prueba <usuario@prueba.local>');
    expect(git('log', '--format=%B', 'orq/tarea-uno', '-1').stdout).not.toMatch(/Co-Authored-By/i);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()).toBe('main');
    expect(git('status', '--porcelain').stdout).toBe('');
  }, 60_000);
});
