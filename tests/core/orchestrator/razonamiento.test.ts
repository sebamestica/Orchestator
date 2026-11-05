import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HintedRunContext } from '../../../src/core/brief/reasoning.ts';
import { DEFAULT_TASK_BUDGET_USD, Fleet, type FleetOptions, type GateCheck } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue, type TaskStateChange } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import type { AgentConfig, QuotaProvider, RunContext, TaskBrief, Workspace } from '../../../src/shared/index.ts';
import { agents, FakeMemory, FakeQuota, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task, verdictScript, type Script, type Step } from './fakes.ts';

/**
 * Issue 6: reintentos que suben el esfuerzo (`RunHints.retries`), tope de gasto por tarea (`RunHints.budgetUsd` y
 * HANDOFF al superarlo) y gate del proyecto antes de la revisión (el revisor no repite el check).
 */

const disposables: FakeWorkspaces[] = [];
afterEach(async () => {
  for (const w of disposables.splice(0)) await w.dispose();
});

const isReview = (t: TaskBrief) => t.id.endsWith('-revision');
const hints = (ctx: RunContext) => ctx as HintedRunContext;
const cost = (costUsd: number): Step => ({ usage: { inputTokens: 1000, outputTokens: 100, costUsd } });

async function setup(opts: { agents: AgentConfig[]; scripts: Record<string, Script | Script[]>; quotas?: QuotaProvider[]; fleet?: Partial<FleetOptions> }) {
  const workspaces = await FakeWorkspaces.create();
  disposables.push(workspaces);
  const queue = new TaskQueue();
  const changes: TaskStateChange[] = [];
  queue.on((c) => changes.push(c));
  const router = new Router({ agents: opts.agents, quotas: opts.quotas ?? [] });
  const adapters = new Map(opts.agents.map((a) => [a.id, new ScriptedAdapter(a, opts.scripts[a.id] ?? [])]));
  const supervisor = new Supervisor({ adapters: adapters.values(), router, sink: new MemorySink(), queue, graceMs: 30 });
  const warnings: string[] = [];
  const fleet = new Fleet({
    queue, router, supervisor, workspaces, memory: new FakeMemory(),
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    warn: (m) => warnings.push(m),
    ...opts.fleet,
  });
  const adapter = (id: string): ScriptedAdapter => {
    const a = adapters.get(id);
    if (!a) throw new Error(`sin adaptador ${id}`);
    return a;
  };
  const transitions = (taskId: string) => changes.filter((c) => c.taskId === taskId).map((c) => `${c.from ?? '∅'}→${c.to}`);
  return { workspaces, queue, router, supervisor, warnings, fleet, adapter, transitions };
}

describe('Supervisor: reintentos que suben el esfuerzo', () => {
  it('cada fallo o tiempo agotado suma un reintento; un traspaso por cupo no; retryBase es el punto de partida', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: { codex: [[{ error: 'crash' }, { done: false }], [{ error: 'quota_exhausted' }, { done: false }]], 'claude-1': okScript() },
    });
    const ws = await s.workspaces.create('demo', task('t1'));
    s.router.acquire('codex');
    const r = await s.supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: ws.path, retryBase: 2 });
    expect(r.ok).toBe(true);
    expect(s.adapter('codex').calls.map((c) => hints(c.ctx).retries)).toEqual([2, 3]);
    // El traspaso a Claude por cupo no sube el esfuerzo: sigue en 3.
    expect(s.adapter('claude-1').calls.map((c) => hints(c.ctx).retries)).toEqual([3]);
  });

  it('sin retryBase ni fallos, el contexto no lleva retries ni budgetUsd', async () => {
    const s = await setup({ agents: [agents.claude1], scripts: { 'claude-1': okScript() } });
    const ws = await s.workspaces.create('demo', task('t1'));
    s.router.acquire('claude-1');
    await s.supervisor.execute(task('t1'), { agentId: 'claude-1', worktreePath: ws.path });
    const ctx = hints(s.adapter('claude-1').calls[0]?.ctx as RunContext);
    expect(ctx.retries).toBeUndefined();
    expect(ctx.budgetUsd).toBeUndefined();
  });
});

describe('Supervisor: tope de gasto de la ejecución', () => {
  it('pasa al adaptador lo que queda; al llegar al tope para sin reintentar ni marcar al agente sin cupo', async () => {
    const quota = new FakeQuota('codex', 0.9);
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [quota],
      scripts: { codex: [[cost(0.6), { error: 'crash' }, { done: false }], [cost(0.5), { error: 'quota_exhausted', message: 'tope del SDK' }, { done: false }]] },
    });
    const ws = await s.workspaces.create('demo', task('t1'));
    s.router.acquire('codex');
    const r = await s.supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: ws.path, budgetUsd: 1 });
    expect(r.outcome).toBe('budget');
    expect(r.ok).toBe(false);
    expect(r.spentUsd).toBeCloseTo(1.1, 9);
    expect(r.error).toBe('tope de gasto alcanzado: 1.1000 de 1.0000 USD');
    expect(s.adapter('codex').calls.map((c) => hints(c.ctx).budgetUsd)).toEqual([1, expect.closeTo(0.4, 9)]);
    expect(r.handoffs).toEqual([]);
    expect(s.adapter('claude-1').calls).toHaveLength(0);
    // No es falta de cupo: Codex sigue disponible.
    expect((await s.router.checkQuota('codex')).allowed).toBe(true);
    expect(s.router.load('codex')).toBe(0);
  });

  it('corta en curso a un adaptador que informa el gasto antes de terminar', async () => {
    const s = await setup({ agents: [agents.claude1], scripts: { 'claude-1': [cost(0.7), { untilAbort: true }, { error: 'cancelled' }, { done: false }] } });
    const ws = await s.workspaces.create('demo', task('t1'));
    const a = await s.supervisor.runAttempt(task('t1'), 'claude-1', { worktreePath: ws.path, budgetUsd: 0.5 });
    expect(a.outcome).toBe('budget');
    expect(a.error).toEqual({ code: 'quota_exhausted', message: 'Tope de gasto de la tarea superado: 0.7000 de 0.5000 USD.' });
  });

  it('sin saldo no empieza ningún intento', async () => {
    const s = await setup({ agents: [agents.claude1], scripts: { 'claude-1': okScript() } });
    const ws = await s.workspaces.create('demo', task('t1'));
    s.router.acquire('claude-1');
    const r = await s.supervisor.execute(task('t1'), { agentId: 'claude-1', worktreePath: ws.path, budgetUsd: 0 });
    expect(r.outcome).toBe('budget');
    expect(s.adapter('claude-1').calls).toHaveLength(0);
    expect(s.router.load('claude-1')).toBe(0);
  });
});

describe('Fleet: tope de gasto por tarea', () => {
  it('topes por defecto: 1 / 3 / 8 USD para low / medium / high', () => {
    expect(DEFAULT_TASK_BUDGET_USD).toEqual({ low: 1, medium: 3, high: 8 });
  });

  it('el autor supera el tope de una tarea low: se detiene con HANDOFF, motivo en detail y aviso; no hay revisión', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2],
      scripts: { 'claude-1': [{ text: 'Avancé el parser.' }, { file: 'src/t1/a.ts' }, cost(1.25), { done: true, summary: 'parser listo' }], 'claude-2': verdictScript('aprobado') },
    });
    s.queue.add(task('t1'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('failed');
    expect(r?.detail).toBe('tope de gasto de la tarea superado: 1.25 de 1 USD (dificultad low); lo hecho queda en .orq/HANDOFF.md: reintenta para continuar desde ahí');
    expect(r?.spentUsd).toBeCloseTo(1.25, 9);
    expect(s.warnings).toContain(`t1: ${r?.detail ?? ''}.`);
    expect(s.adapter('claude-2').calls).toHaveLength(0);
    const handoff = await readFile(join(s.workspaces.root, 'demo', 't1', '.orq', 'HANDOFF.md'), 'utf8');
    expect(handoff).toMatch(/^# Traspaso de t1\n\n## Detenida por el tope de gasto \(/);
    expect(handoff).toContain('Archivos tocados: src/t1/a.ts.');
    expect(handoff).toContain('Resumen del agente: parser listo');
    // El worktree de una tarea fallida se conserva para el reintento.
    expect(s.workspaces.removed).toEqual([]);
  });

  it('un HANDOFF.md del agente se conserva: la sección del tope va al final', async () => {
    const s = await setup({
      agents: [agents.claude1],
      scripts: {
        'claude-1': [
          { effect: async (ctx) => { await mkdir(join(ctx.worktreePath, '.orq'), { recursive: true }); await writeFile(join(ctx.worktreePath, '.orq', 'HANDOFF.md'), '# Mi traspaso\nFalta el paso 3.', 'utf8'); } },
          cost(2),
          { error: 'crash' },
          { done: false },
        ],
      },
    });
    s.queue.add(task('t1'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('failed');
    // Un fallo que ya superó el tope no se reintenta.
    expect(s.adapter('claude-1').calls).toHaveLength(1);
    const handoff = await readFile(join(s.workspaces.root, 'demo', 't1', '.orq', 'HANDOFF.md'), 'utf8');
    expect(handoff.startsWith('# Mi traspaso\nFalta el paso 3.\n\n## Detenida por el tope de gasto')).toBe(true);
  });

  it('la revisión recibe lo que queda del tope y su gasto también cuenta', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2],
      scripts: { 'claude-1': [cost(0.4), ...okScript()], 'claude-2': [cost(0.3), ...verdictScript('aprobado')] },
    });
    s.queue.add(task('t1', { difficulty: 'medium' }));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('integrated');
    expect(hints(s.adapter('claude-1').calls[0]?.ctx as RunContext).budgetUsd).toBe(3);
    expect(hints(s.adapter('claude-2').calls[0]?.ctx as RunContext).budgetUsd).toBeCloseTo(2.6, 9);
    expect(r?.spentUsd).toBeCloseTo(0.7, 9);
  });

  it('el revisor que agota lo que queda también detiene la tarea con HANDOFF', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2],
      scripts: { 'claude-1': [cost(0.8), ...okScript()], 'claude-2': [cost(0.5), { error: 'quota_exhausted' }, { done: false }] },
    });
    s.queue.add(task('t1'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('failed');
    expect(r?.detail).toMatch(/^tope de gasto de la tarea superado: 1\.30 de 1 USD/);
    expect(s.workspaces.integrated).toEqual([]);
  });

  it('taskBudgetUsd: null desactiva el tope; uno propio por dificultad manda', async () => {
    const free = await setup({ agents: [agents.claude1, agents.claude2], scripts: { 'claude-1': [cost(50), ...okScript()], 'claude-2': verdictScript('aprobado') }, fleet: { taskBudgetUsd: null } });
    free.queue.add(task('t1'));
    expect((await free.fleet.run()).tasks[0]?.state).toBe('integrated');
    expect(hints(free.adapter('claude-1').calls[0]?.ctx as RunContext).budgetUsd).toBeUndefined();

    const own = await setup({ agents: [agents.claude1, agents.claude2], scripts: { 'claude-1': okScript(), 'claude-2': verdictScript('aprobado') }, fleet: { taskBudgetUsd: { high: 20 } } });
    own.queue.add(task('ta', { difficulty: 'high' }));
    own.queue.add(task('tb'));
    await own.fleet.run();
    const calls = [...own.adapter('claude-1').calls, ...own.adapter('claude-2').calls];
    const budgetOf = (id: string) => hints(calls.find((c) => c.task.id === id)?.ctx as RunContext).budgetUsd;
    expect(budgetOf('ta')).toBe(20);
    expect(budgetOf('tb')).toBeUndefined(); // low sin tope en esa tabla
  });
});

describe('Fleet: reintentos de autor suben el esfuerzo', () => {
  it('una ronda de corrección tras un rechazo llega con retries = 1', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2],
      scripts: { 'claude-1': okScript(), 'claude-2': [verdictScript('rechazado', ['falta la prueba']), verdictScript('aprobado')] },
    });
    s.queue.add(task('t1'));
    expect((await s.fleet.run()).tasks[0]?.state).toBe('integrated');
    expect(s.adapter('claude-1').calls.map((c) => hints(c.ctx).retries)).toEqual([undefined, 1]);
    // El segundo revisor no es un reintento de revisión.
    expect(s.adapter('claude-2').calls.map((c) => hints(c.ctx).retries)).toEqual([undefined, undefined]);
  });
});

describe('Fleet: gate del proyecto antes de la revisión', () => {
  const GATE_OK = 'gate ok (1 comandos)\n- npm run -s check: ok en 61000 ms';

  it('pasa: corre una vez, sin LLM, y su resumen va en el encargo; el revisor no repite el check', async () => {
    const calls: { workspace: Workspace; taskId: string }[] = [];
    const s = await setup({
      agents: [agents.claude1, agents.claude2],
      scripts: { 'claude-1': okScript('hecho', 'src/t1/a.ts'), 'claude-2': verdictScript('aprobado') },
      fleet: { verify: async (workspace, t) => { calls.push({ workspace, taskId: t.id }); return { ok: true, summary: GATE_OK }; } },
    });
    s.queue.add(task('t1'));
    expect((await s.fleet.run()).tasks[0]?.state).toBe('integrated');
    expect(calls.map((c) => [c.taskId, c.workspace.path])).toEqual([['t1', join(s.workspaces.root, 'demo', 't1')]]);
    const review = s.adapter('claude-2').calls[0]?.task;
    expect(review && isReview(review)).toBe(true);
    expect(review?.objective).toContain(`### Verificación del proyecto (gate)\nBerland ya la corrió en este worktree, sin LLM, y pasó:\n${GATE_OK}`);
    expect(review?.objective).toContain('No vuelvas a correr la verificación completa');
    expect(review?.objective).not.toContain('que la verificación del proyecto pasa');
  });

  it('falla: la tarea vuelve al autor con el resumen, sin gastar una revisión; al pasar, se revisa', async () => {
    const results: GateCheck[] = [
      { ok: false, summary: 'gate fallido (1/1 comandos)\n- npm run -s check: falló (código 1) en 9000 ms\nsalida:\n  FAIL tests/a.test.ts' },
      { ok: true, summary: GATE_OK },
    ];
    const s = await setup({
      agents: [agents.claude1, agents.claude2],
      scripts: { 'claude-1': okScript(), 'claude-2': verdictScript('aprobado') },
      fleet: { verify: async () => results.shift() },
    });
    s.queue.add(task('t1'));
    expect((await s.fleet.run()).tasks[0]?.state).toBe('integrated');
    const authorCalls = s.adapter('claude-1').calls;
    expect(authorCalls).toHaveLength(2);
    expect(authorCalls[1]?.task.objective).toContain('### Observaciones (verificación del proyecto, ronda 1)');
    expect(authorCalls[1]?.task.objective).toContain('FAIL tests/a.test.ts');
    expect(hints(authorCalls[1]?.ctx as RunContext).retries).toBe(1);
    expect(s.adapter('claude-2').calls).toHaveLength(1);
    expect(s.transitions('t1')).toEqual(['∅→pending', 'pending→ready', 'ready→running', 'running→review', 'review→running', 'running→review', 'review→integrated']);
  });

  it('sin gate (verify devuelve undefined) o si verify falla, el revisor lo comprueba como antes', async () => {
    const none = await setup({ agents: [agents.claude1, agents.claude2], scripts: { 'claude-1': okScript(), 'claude-2': verdictScript('aprobado') }, fleet: { verify: async () => undefined } });
    none.queue.add(task('t1'));
    await none.fleet.run();
    expect(none.adapter('claude-2').calls[0]?.task.objective).toContain('que la verificación del proyecto pasa');

    const broken = await setup({
      agents: [agents.claude1, agents.claude2],
      scripts: { 'claude-1': okScript(), 'claude-2': verdictScript('aprobado') },
      fleet: { verify: async () => { throw new Error('npm no encontrado'); } },
    });
    broken.queue.add(task('t1'));
    expect((await broken.fleet.run()).tasks[0]?.state).toBe('integrated');
    expect(broken.warnings).toContain('t1: no se pudo correr la verificación antes de revisar (npm no encontrado); la comprueba el revisor.');
    expect(broken.adapter('claude-2').calls[0]?.task.objective).toContain('que la verificación del proyecto pasa');
  });

  it('usa workspaces.verify si el gestor lo tiene', async () => {
    const s = await setup({ agents: [agents.claude1, agents.claude2], scripts: { 'claude-1': okScript(), 'claude-2': verdictScript('aprobado') } });
    const seen: string[] = [];
    Object.assign(s.workspaces, { verify: async (w: Workspace) => { seen.push(w.taskId); return { ok: true, summary: 'gate ok (del gestor)' }; } });
    const fleet = new Fleet({ queue: s.queue, router: s.router, supervisor: s.supervisor, workspaces: s.workspaces, memory: new FakeMemory(), warn: () => undefined });
    s.queue.add(task('t1'));
    expect((await fleet.run()).tasks[0]?.state).toBe('integrated');
    expect(seen).toEqual(['t1']);
    expect(s.adapter('claude-2').calls[0]?.task.objective).toContain('gate ok (del gestor)');
  });
});
