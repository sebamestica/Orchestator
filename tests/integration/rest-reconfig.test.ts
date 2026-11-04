import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { startCore, type Core } from '../../src/core/main.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import type { AgentAdapter, AgentConfig, AgentEvent, ProbeResult, RunContext, TaskBrief } from '../../src/shared/index.ts';
import { cleanupDirs, fakeKey, tempDir } from './helpers.ts';

// Segunda revisión de Codex sobre c13 (H4): DELETE /projects tiene que ver lo que la flota hace de verdad, y una
// cancelación que la flota rechaza (la tarea ya se está integrando) no puede quedar como `cancelled` en el almacén.
vi.setConfig({ testTimeout: 180_000 });

const cores: Core[] = [];
const comps: Composition[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const c of comps.splice(0)) await c.shutdown();
  await cleanupDirs();
});

/** Autor: escribe su primera ruta propia; revisor: aprueba. */
function workerAdapter(config: AgentConfig): AgentAdapter {
  return {
    config,
    async probe(): Promise<ProbeResult> {
      return { agentId: config.id, installed: true, authenticated: true, models: [], quotaMethod: 'none', warnings: [] };
    },
    async *run(task: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent> {
      const base = { sessionId: `${config.id}-${task.id}`, agentId: config.id, ts: new Date().toISOString() };
      let text = '{"veredicto":"aprobado","observaciones":[]}';
      if (!task.id.endsWith('-revision')) {
        const rel = task.ownedPaths[0] ?? 'x.txt';
        mkdirSync(join(ctx.worktreePath, rel, '..'), { recursive: true });
        writeFileSync(join(ctx.worktreePath, rel), `// hecho por ${config.id}\n`);
        text = 'Listo.';
      }
      yield { ...base, seq: 0, type: 'text', payload: { role: 'assistant', text } };
      yield { ...base, seq: 1, type: 'done', payload: { ok: true } };
    },
  };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 120_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('tiempo agotado esperando la condición');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('REST: reconfigurar con una integración en curso', () => {
  it('con el gate detenido: cancelar responde 409 sin marcar cancelled y DELETE responde 409 aunque el almacén diga cancelled; al terminar, DELETE borra', async () => {
    const root = await tempDir('orq-rest-reconf-');
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@local', ...args], { cwd: repo, encoding: 'utf8' });
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'inicio']]) expect(git(...args).status).toBe(0);
    const started = join(root, 'gate-empezo');
    const open = join(root, 'abrir');
    const barrier = {
      command: 'node',
      args: ['-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'');const t0=Date.now();const w=()=>{if(fs.existsSync(${JSON.stringify(open)}))process.exit(0);if(Date.now()-t0>120000)process.exit(9);setTimeout(w,50)};w()`],
    };

    const comp = compose({
      env: { ORQ_DATA_DIR: join(root, 'datos') },
      config: { port: 0, quotaRefreshMs: 0 },
      vault: new MemoryVault(),
      memoryDir: join(root, 'memoria'),
      skillsHubDir: join(root, 'hub'),
      detectors: [],
      hostEnv: () => ({}),
      constructors: { claudeSdk: (o) => workerAdapter(o.config), codexCli: (c) => workerAdapter(c) },
    });
    comps.push(comp);
    await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: fakeKey(), displayName: 'Claude', id: 'claude' });
    comp.registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
    const core = await startCore(comp.deps);
    cores.push(core);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${core.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${core.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const state = async (id: string) => String(((await call('GET', `/tasks/${id}`)).json.task as { state: string }).state);

    const project = { id: 'demo', name: 'Demo', repoPath: repo, workspace: { worktreesRoot: join(root, 'wt'), gate: [barrier] } };
    expect((await call('POST', '/projects', project)).status).toBe(201);
    const task = { id: 'tarea-uno', projectId: 'demo', title: 'Uno', objective: 'Crear src/uno.mjs', ownedPaths: ['src/uno.mjs'], dependsOn: [], acceptance: ['existe'], difficulty: 'low' };
    expect((await call('POST', '/tasks', task)).status).toBe(201);
    expect((await call('POST', '/tasks/tarea-uno/approve', { agentId: 'codex' })).status).toBe(200);
    await until(() => existsSync(started)); // la integración está en su gate

    // La flota rechaza cancelar pasado el punto de compromiso: el servidor responde 409 y no persiste `cancelled`.
    const cancel = await call('POST', '/tasks/tarea-uno/cancel', { reason: 'probar' });
    expect(cancel.status).toBe(409);
    expect(JSON.stringify(cancel.json)).toMatch(/se está integrando/);
    expect(await state('tarea-uno')).toBe('review');

    // DELETE ve la integración en curso: por el estado guardado y, aunque el almacén dijera `cancelled`, por la flota.
    expect((await call('DELETE', '/projects/demo')).status).toBe(409);
    comp.store.setTaskState('tarea-uno', 'cancelled');
    const del = await call('DELETE', '/projects/demo');
    expect(del.status).toBe(409);
    expect(JSON.stringify(del.json)).toMatch(/tarea-uno/);

    writeFileSync(open, '');
    await until(async () => (await state('tarea-uno')) === 'integrated');
    expect(git('show', 'orq/integracion:src/uno.mjs').stdout).toBe('// hecho por codex\n');
    // Cuando la flota termina (también la limpieza del worktree), el proyecto se puede borrar.
    await until(async () => (await call('DELETE', '/projects/demo')).status === 200);
    expect(existsSync(join(root, 'wt', 'tarea-uno'))).toBe(false);
  });
});
