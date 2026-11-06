import { afterEach, describe, expect, it } from 'vitest';
import { FleetRuntime, withContinuation, type SavedTask } from '../../../src/core/app/fleet-port.ts';
import { Fleet } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import { PLAN_FILES, type TaskBrief, type TaskState } from '../../../src/shared/index.ts';
import { agents, FakeMemory, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task, verdictScript, type Script } from '../orchestrator/fakes.ts';

const disposables: FakeWorkspaces[] = [];
const runtimes: FleetRuntime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stop();
  for (const w of disposables.splice(0)) await w.dispose();
});

const failScript: Script = [{ text: 'empiezo' }, { error: 'crash', message: 'se cayó la red a mitad de npm test' }, { done: false }];

/** Flota real (cola, router, supervisor) con agentes guionados: Claude escribe, Codex revisa. */
async function setup(opts: { author: Script[]; saved?: (id: string) => SavedTask | undefined; queue?: TaskQueue; workspaces?: FakeWorkspaces }) {
  const workspaces = opts.workspaces ?? (await FakeWorkspaces.create());
  if (!opts.workspaces) disposables.push(workspaces);
  const queue = opts.queue ?? new TaskQueue();
  const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [] });
  const claude = new ScriptedAdapter(agents.claude1, opts.author);
  const codex = new ScriptedAdapter(agents.codex, verdictScript('aprobado'));
  const supervisor = new Supervisor({ adapters: [claude, codex], router, sink: new MemorySink(), queue, graceMs: 30, maxAttempts: 1 });
  const fleet = new Fleet({ queue, router, supervisor, workspaces, memory: new FakeMemory(), warn: () => undefined });
  const runtime = new FleetRuntime({ queue, fleet, ...(opts.saved ? { saved: opts.saved } : {}) });
  runtimes.push(runtime);
  return { workspaces, queue, claude, codex, runtime };
}

async function until(queue: TaskQueue, id: string, states: readonly TaskState[]): Promise<TaskState> {
  for (let i = 0; i < 400; i++) {
    const state = queue.get(id)?.state;
    if (state && states.includes(state)) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  return queue.get(id)?.state ?? 'pending';
}

const brief = (id: string, extra: Partial<TaskBrief> = {}) => task(id, { suggestedAgent: 'claude-1', ...extra });

describe('FleetRuntime.stop: detener el núcleo', () => {
  it('la tarea en curso queda fallida y reintentable; su dependiente sigue pendiente', async () => {
    const s = await setup({ author: [[{ untilAbort: true }, { error: 'cancelled' }, { done: false }]] });
    await s.runtime.delegate(brief('ta'));
    await s.runtime.delegate(brief('tb', { dependsOn: ['ta'] }));
    expect(await until(s.queue, 'ta', ['running'])).toBe('running');
    await s.runtime.stop();
    expect(s.queue.get('ta')?.state).toBe('failed');
    expect(s.runtime.status('ta')?.detail).toMatch(/interrumpida al detener el núcleo/);
    expect(s.queue.get('tb')?.state).toBe('pending');
  });
});

describe('FleetRuntime.retry: tarea fallida en la cola', () => {
  it('vuelve a ready, corre en el mismo worktree con la sección «Continuación» y se integra', async () => {
    const s = await setup({ author: [failScript, okScript('listo al segundo intento')] });
    expect(await s.runtime.delegate(brief('t1'))).toMatchObject({ accepted: true });
    expect(await until(s.queue, 't1', ['failed', 'integrated'])).toBe('failed');
    // El motivo llega al estado de la mente.
    expect(s.runtime.status('t1')?.detail).toMatch(/se cayó la red a mitad de npm test/);

    const result = await s.runtime.retry('t1', 'reintento pedido por el usuario');
    expect(result).toMatchObject({ accepted: true, detail: expect.stringMatching(/en la cola/) });
    expect(await until(s.queue, 't1', ['integrated', 'failed'])).toBe('integrated');

    const second = s.claude.calls[1];
    expect(second?.task.objective).toContain('### Continuación');
    expect(second?.task.objective).toContain('se cayó la red a mitad de npm test');
    expect(second?.task.objective).toContain(PLAN_FILES.taskPlan);
    // El objetivo original sigue al principio y no se duplica.
    expect(second?.task.objective.startsWith('Implementar t1')).toBe(true);
    expect(s.claude.calls[0]?.ctx.worktreePath).toBe(second?.ctx.worktreePath);
  });

  it('un segundo reintento no acumula secciones «Continuación»', async () => {
    const s = await setup({ author: [failScript, failScript, okScript()] });
    await s.runtime.delegate(brief('t2'));
    expect(await until(s.queue, 't2', ['failed'])).toBe('failed');
    await s.runtime.retry('t2');
    // Tras volver a `ready`, esperar a que el segundo intento termine (falla de nuevo).
    for (let i = 0; i < 400 && s.claude.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await until(s.queue, 't2', ['failed'])).toBe('failed');
    await s.runtime.retry('t2');
    expect(await until(s.queue, 't2', ['integrated'])).toBe('integrated');
    const third = s.claude.calls[2]?.task.objective ?? '';
    expect(third.split('### Continuación')).toHaveLength(2);
  });

  it('solo reintenta una tarea fallida', async () => {
    const s = await setup({ author: [okScript()] });
    await s.runtime.delegate(brief('t3'));
    expect(await until(s.queue, 't3', ['integrated'])).toBe('integrated');
    expect(await s.runtime.retry('t3')).toEqual({ accepted: false, reason: expect.stringMatching(/estado integrated: solo se reintenta una tarea fallida/) });
    expect(await s.runtime.retry('no-existe')).toEqual({ accepted: false, reason: 'No existe la tarea no-existe' });
  });
});

describe('FleetRuntime.retry: después de un reinicio (cola nueva, misma base)', () => {
  it('reencola desde la base con su encargo guardado y su motivo; las dependencias integradas ya no hacen falta', async () => {
    const saved = new Map<string, SavedTask>([
      ['base', { task: brief('base'), state: 'integrated', agentId: 'claude-1', detail: null, attempts: 1, updatedAt: '2026-11-04T18:00:00.000Z' }],
      [
        'hija',
        {
          task: brief('hija', { dependsOn: ['base'] }),
          state: 'failed',
          agentId: 'claude-1',
          detail: 'interrumpida al reiniciar el núcleo',
          attempts: 3,
          updatedAt: '2026-11-04T23:39:00.000Z',
        },
      ],
    ]);
    const s = await setup({ author: [okScript('hecho tras reiniciar')], saved: (id) => saved.get(id) });
    // La cola nueva no la conoce: la mente igual ve el estado guardado y su motivo.
    expect(s.runtime.status('hija')).toMatchObject({ state: 'failed', detail: 'interrumpida al reiniciar el núcleo' });
    expect(s.runtime.status('base')).toMatchObject({ state: 'integrated' });

    const result = await s.runtime.retry('hija');
    expect(result).toMatchObject({ accepted: true, detail: expect.stringMatching(/desde la base/) });
    expect(await until(s.queue, 'hija', ['integrated', 'failed'])).toBe('integrated');
    const call = s.claude.calls[0];
    expect(call?.task.dependsOn).toEqual([]);
    expect(call?.task.objective).toContain('### Continuación (intento 4)');
    expect(call?.task.objective).toContain('Último motivo: interrumpida al reiniciar el núcleo');
  });

  it('una dependencia que no está integrada ni en la cola impide el reintento', async () => {
    const saved = new Map<string, SavedTask>([
      ['base', { task: brief('base'), state: 'failed', agentId: null, detail: 'falló', attempts: 1, updatedAt: '2026-11-04T18:00:00.000Z' }],
      ['hija', { task: brief('hija', { dependsOn: ['base'] }), state: 'failed', agentId: null, detail: 'x', attempts: 1, updatedAt: '2026-11-04T18:00:00.000Z' }],
    ]);
    const s = await setup({ author: [okScript()], saved: (id) => saved.get(id) });
    expect(await s.runtime.retry('hija')).toEqual({ accepted: false, reason: expect.stringMatching(/depende de base \(failed\), que no está integrada ni en la flota/) });
    expect(s.queue.get('hija')).toBeUndefined();
    expect(await s.runtime.retry('base')).toMatchObject({ accepted: true });
  });

  it('una tarea guardada que no está fallida no se reintenta', async () => {
    const saved: SavedTask = { task: brief('viva'), state: 'running', agentId: 'claude-1', detail: null, attempts: 1, updatedAt: '2026-11-04T18:00:00.000Z' };
    const s = await setup({ author: [okScript()], saved: (id) => (id === 'viva' ? saved : undefined) });
    expect(await s.runtime.retry('viva')).toEqual({ accepted: false, reason: expect.stringMatching(/estado running/) });
    // Una tarea en curso que la cola no tiene no se informa como si estuviera viva.
    expect(s.runtime.status('viva')).toBeUndefined();
  });
});

describe('FleetRuntime.list: después de un reinicio (cola nueva, misma base)', () => {
  it('trae las tareas guardadas que la cola no tiene, con su proyecto; la cola gana y una en curso sin cola no se informa', () => {
    const saved: SavedTask[] = [
      { task: brief('api'), state: 'integrated', agentId: 'claude-1', detail: null, attempts: 1, updatedAt: '2026-11-04T18:00:00.000Z' },
      { task: brief('ui'), state: 'failed', agentId: null, detail: 'interrumpida al reiniciar el núcleo', attempts: 1, updatedAt: '2026-11-04T18:00:00.000Z' },
      { task: brief('nueva'), state: 'pending', agentId: null, detail: null, attempts: 0, updatedAt: '2026-11-04T18:00:00.000Z' },
      { task: brief('tablero'), state: 'pending', agentId: null, detail: null, attempts: 0, updatedAt: '2026-11-04T18:00:00.000Z' },
      { task: brief('viva'), state: 'running', agentId: 'claude-1', detail: null, attempts: 1, updatedAt: '2026-11-04T18:00:00.000Z' },
    ];
    const queue = new TaskQueue();
    queue.add(brief('nueva'));
    const runtime = new FleetRuntime({ queue, savedList: () => saved });
    expect(runtime.list().map((s) => [s.taskId, s.state, s.projectId, s.detail])).toEqual([
      ['nueva', 'ready', 'demo', undefined],
      ['api', 'integrated', 'demo', undefined],
      ['ui', 'failed', 'demo', 'interrumpida al reiniciar el núcleo'],
      ['tablero', 'pending', 'demo', undefined],
    ]);
  });
});

describe('withContinuation', () => {
  it('agrega el motivo (tachado, en una línea) y los archivos para seguir', () => {
    const key = `sk-ant-api03-${'K'.repeat(40)}`;
    const out = withContinuation(brief('t9'), { reason: `falló con ${key}\n en dos líneas`, attempt: 2 });
    expect(out.objective).toContain('### Continuación (intento 2)');
    expect(out.objective).toContain('Último motivo: falló con');
    expect(out.objective).not.toContain('sk-ant-api03');
    expect(out.objective).toContain(PLAN_FILES.handoff);
    expect(out).toMatchObject({ id: 't9', ownedPaths: ['src/t9/**'] });
  });
});
