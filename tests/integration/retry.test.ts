import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { INTERRUPTED_DETAIL } from '../../src/core/app/fleet-service.ts';
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

interface Run {
  agent: string;
  task: TaskBrief;
  cwd: string;
}

/** Agente falso: como autor escribe su ruta propia o falla si `failing`; como revisor aprueba en JSON. */
function workerAdapter(config: AgentConfig, runs: Run[], control: { failing: boolean }): AgentAdapter {
  return {
    config,
    async probe(): Promise<ProbeResult> {
      return { agentId: config.id, installed: true, authenticated: true, models: [], quotaMethod: 'none', warnings: [] };
    },
    async *run(task: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent> {
      runs.push({ agent: config.id, task, cwd: ctx.worktreePath });
      const base = { sessionId: `${config.id}-${task.id}-${runs.length}`, agentId: config.id, ts: new Date().toISOString() };
      const review = task.id.endsWith('-revision');
      if (!review && control.failing) {
        yield { ...base, seq: 0, type: 'text', payload: { role: 'assistant', text: 'Empiezo y corro las pruebas.' } };
        yield { ...base, seq: 1, type: 'error', payload: { code: 'crash', message: 'se cortó el proceso de pruebas' } };
        yield { ...base, seq: 2, type: 'done', payload: { ok: false } };
        return;
      }
      let text = '{"veredicto":"aprobado","observaciones":[]}';
      if (!review) {
        const rel = task.ownedPaths[0] ?? 'x.txt';
        mkdirSync(join(ctx.worktreePath, rel, '..'), { recursive: true });
        writeFileSync(join(ctx.worktreePath, rel), `hecho por ${config.id}\n`);
        text = 'Listo.';
      }
      yield { ...base, seq: 0, type: 'text', payload: { role: 'assistant', text } };
      yield { ...base, seq: 1, type: 'done', payload: { ok: true } };
    },
  };
}

/** La bóveda sobrevive al reinicio (en Windows es el archivo DPAPI): se comparte entre arranques. */
async function boot(root: string, runs: Run[], control: { failing: boolean }, vault: MemoryVault) {
  const comp = compose({
    env: { ORQ_DATA_DIR: join(root, 'datos') },
    config: { port: 0, quotaRefreshMs: 0 },
    vault,
    memoryDir: join(root, 'memoria'),
    skillsHubDir: join(root, 'hub'),
    detectors: [],
    hostEnv: () => ({}),
    constructors: { claudeSdk: (o) => workerAdapter(o.config, runs, control), codexCli: (c) => workerAdapter(c, runs, control) },
    validateResponses: true,
  });
  comps.push(comp);
  if (!comp.registry.get('claude')) await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: fakeKey(), displayName: 'Claude', id: 'claude' });
  if (!comp.registry.get('codex')) comp.registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
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
  const taskOf = async (id: string) => (await call('GET', `/tasks/${id}`)).json.task as {
    state: string;
    detail: string | null;
    attempts: number;
    lastEventAt: string | null;
    agentId: string | null;
  };
  const settle = async (id: string) => {
    let t = await taskOf(id);
    for (let i = 0; i < 400 && !['integrated', 'failed', 'cancelled'].includes(t.state); i++) {
      await new Promise((r) => setTimeout(r, 50));
      t = await taskOf(id);
    }
    return t;
  };
  const stop = async () => {
    cores.splice(cores.indexOf(core), 1);
    comps.splice(comps.indexOf(comp), 1);
    await core.stop();
    await comp.shutdown();
  };
  return { comp, core, call, taskOf, settle, stop };
}

const brief = (id: string, file: string) => ({
  id,
  projectId: 'marketing',
  title: `Tarea ${id}`,
  objective: `Escribir ${file}`,
  ownedPaths: [file],
  dependsOn: [],
  acceptance: ['existe'],
  difficulty: 'low',
  suggestedAgent: 'codex',
});

describe('reactivar tareas: motivo, reintento y arranque (servidor real, modo local, sin red)', () => {
  it('guarda por qué falló, reintenta desde la cola y, tras reiniciar el núcleo, desde la base', async () => {
    const root = await tempDir('orq-retry-');
    const folder = join(root, 'marketing');
    mkdirSync(folder, { recursive: true });
    const runs: Run[] = [];
    const control = { failing: true };
    const vault = new MemoryVault();
    const a = await boot(root, runs, control, vault);
    // Proyecto sin `workspace`: modo local (como la carpeta de marketing).
    expect((await a.call('POST', '/projects', { id: 'marketing', name: 'Marketing', repoPath: folder })).status).toBe(201);

    // 1. Falla y deja su motivo en la base; GET /tasks/:id lo devuelve, con el último evento y los intentos.
    expect((await a.call('POST', '/tasks', brief('guion-uno', 'guiones/uno.md'))).status).toBe(201);
    expect((await a.call('POST', '/tasks/guion-uno/approve', {})).status).toBe(200);
    const failed = await a.settle('guion-uno');
    expect(failed.state).toBe('failed');
    expect(failed.detail).toMatch(/guion-uno: sin éxito tras 4 intentos/);
    expect(failed.detail).toMatch(/se cortó el proceso de pruebas/);
    expect(failed.attempts).toBe(1);
    expect(failed.lastEventAt).toEqual(expect.any(String));
    const sessions = (await a.call('GET', '/sessions?taskId=guion-uno')).json.sessions as unknown[];
    expect(sessions.length).toBeGreaterThan(0);
    // La carpeta conserva su `.orq/` (la de una tarea fallida no se limpia).
    expect(existsSync(join(folder, '.orq', 'BRIEF.md'))).toBe(true);

    // 2a. Reintento con la tarea fallida en la cola: queda ready y corre hasta integrarse.
    control.failing = false;
    const retried = await a.call('POST', '/tasks/guion-uno/retry');
    expect(retried.status).toBe(200);
    expect(['ready', 'running']).toContain((retried.json.task as { state: string }).state);
    const done = await a.settle('guion-uno');
    expect(done).toMatchObject({ state: 'integrated', attempts: 2 });
    const author = runs.filter((r) => r.task.id === 'guion-uno').at(-1);
    expect(author?.task.objective).toContain('### Continuación (intento 2)');
    expect(author?.task.objective).toMatch(/Último motivo: guion-uno: sin éxito tras 4 intentos/);
    expect(author?.cwd).toBe(folder);

    // 2c. Con la tarea integrada (o inexistente) no se reintenta.
    const conflict = await a.call('POST', '/tasks/guion-uno/retry');
    expect(conflict.status).toBe(409);
    expect((conflict.json.error as { message: string }).message).toMatch(/estado integrated/);
    expect((await a.call('POST', '/tasks/no-existe/retry')).status).toBe(404);

    // Antes de «reiniciar»: una tarea fallida y otra que queda en curso en la base (el núcleo se cae a mitad).
    control.failing = true;
    expect((await a.call('POST', '/tasks', brief('guion-dos', 'guiones/dos.md'))).status).toBe(201);
    expect((await a.call('POST', '/tasks/guion-dos/approve', {})).status).toBe(200);
    expect((await a.settle('guion-dos')).state).toBe('failed');
    a.comp.store.putTask({ ...brief('guion-tres', 'guiones/tres.md'), contextRefs: [], skillRefs: [], difficulty: 'low' }, 'running');
    expect((await a.call('POST', '/tasks/guion-tres/retry')).status).toBe(409);
    a.comp.store.append({ sessionId: 'codex-colgada', agentId: 'codex', seq: 0, ts: new Date().toISOString(), type: 'text', payload: { text: 'a medias', role: 'assistant' } });
    await a.stop();

    // 3. Arranque nuevo (cola nueva, misma base): la huérfana queda fallida con el motivo y su sesión, cancelada.
    control.failing = false;
    const b = await boot(root, runs, control, vault);
    expect(await b.taskOf('guion-tres')).toMatchObject({ state: 'failed', detail: INTERRUPTED_DETAIL });
    expect(b.comp.store.getSession('codex-colgada')?.state).toBe('cancelled');
    expect(await b.taskOf('guion-uno')).toMatchObject({ state: 'integrated' });

    // 2b. Reintento después del reinicio: se reencola desde la base con su encargo guardado.
    const fromBase = await b.call('POST', '/tasks/guion-dos/retry');
    expect(fromBase.status, JSON.stringify(fromBase.json)).toBe(200);
    expect(await b.settle('guion-dos')).toMatchObject({ state: 'integrated', attempts: 2 });
    const second = runs.filter((r) => r.task.id === 'guion-dos').at(-1);
    expect(second?.task.objective).toContain('### Continuación (intento 2)');
    expect((await b.call('POST', '/tasks/guion-tres/retry')).status).toBe(200);
    expect((await b.settle('guion-tres')).state).toBe('integrated');
  }, 90_000);
});
