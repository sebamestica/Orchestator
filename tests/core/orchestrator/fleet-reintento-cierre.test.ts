import { afterEach, describe, expect, it } from 'vitest';
import { FleetRuntime } from '../../../src/core/app/fleet-port.ts';
import { Fleet, type FleetReport } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import type { SessionSummary, TaskBrief, TaskState } from '../../../src/shared/index.ts';
import { agents, delay, FakeMemory, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task, verdictScript, type Step } from './fakes.ts';

const disposables: FakeWorkspaces[] = [];
afterEach(async () => {
  for (const w of disposables.splice(0)) await w.dispose();
});

/** Memoria cuyo primer `recordSession` de la tarea `held` espera a `release()` (bóveda ocupada). */
class HeldMemory extends FakeMemory {
  readonly held: string;
  release: () => void = () => undefined;
  /** Se resuelve cuando el ciclo de `held` queda retenido guardando su sesión. */
  readonly entered: Promise<void>;
  #enter: () => void = () => undefined;
  #done = false;
  readonly #gate: Promise<void>;

  constructor(held: string) {
    super();
    this.held = held;
    this.#gate = new Promise<void>((resolve) => { this.release = resolve; });
    this.entered = new Promise<void>((resolve) => { this.#enter = resolve; });
  }

  override async recordSession(summary: SessionSummary): Promise<void> {
    if (summary.taskId === this.held && !this.#done) {
      this.#done = true;
      this.#enter();
      await this.#gate;
    }
    await super.recordSession(summary);
  }
}

/**
 * Flota real con Claude de autor y Codex de revisor. `ta` falla en su primera pasada y termina bien en la siguiente
 * (tras `secondWaitMs`); `tx` tarda `xWaitMs`; las demás terminan enseguida.
 */
async function setup(opts: { concurrency: number; secondWaitMs: number; xWaitMs?: number }) {
  const workspaces = await FakeWorkspaces.create();
  disposables.push(workspaces);
  const queue = new TaskQueue({ concurrency: opts.concurrency });
  const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [] });
  const passes = new Map<string, number>();
  const author = (t: TaskBrief): Step[] => {
    const n = (passes.get(t.id) ?? 0) + 1;
    passes.set(t.id, n);
    if (t.id === 'ta') return n === 1 ? [{ done: false }] : [{ wait: opts.secondWaitMs }, ...okScript('ta al segundo intento')];
    if (t.id === 'tx') return [{ wait: opts.xWaitMs ?? 0 }, ...okScript('tx')];
    return okScript(t.id);
  };
  const claude = new ScriptedAdapter(agents.claude1, author);
  const codex = new ScriptedAdapter(agents.codex, verdictScript('aprobado'));
  const supervisor = new Supervisor({ adapters: [claude, codex], router, sink: new MemorySink(), queue, graceMs: 30, maxAttempts: 1 });
  const memory = new HeldMemory('ta');
  const fleet = new Fleet({ queue, router, supervisor, workspaces, memory, warn: () => undefined });
  const authorPasses = (id: string) => passes.get(id) ?? 0;
  return { queue, fleet, memory, claude, authorPasses };
}

const brief = (id: string, extra: Partial<TaskBrief> = {}) => task(id, { suggestedAgent: 'claude-1', ...extra });

async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await delay(10);
  }
  throw new Error(`no se cumplió: ${label}`);
}

/** Lanza `run()` y anota los estados de `ids` en el momento en que resuelve. */
function track(fleet: Fleet, queue: TaskQueue, ids: string[]) {
  const at: { resolved: boolean; states: Record<string, TaskState> } = { resolved: false, states: {} };
  const done: Promise<FleetReport> = fleet.run().then((report) => {
    at.resolved = true;
    for (const id of ids) at.states[id] = queue.state(id);
    return report;
  });
  return { at, done };
}

describe('Fleet: reintento mientras el ciclo anterior guarda sus sesiones (flota-06)', () => {
  it('no lanza un segundo ciclo con el mismo id y no deja varado al dependiente (concurrencia 2)', async () => {
    const s = await setup({ concurrency: 2, secondWaitMs: 300, xWaitMs: 150 });
    s.queue.addAll([brief('ta'), brief('tb', { dependsOn: ['ta'] }), brief('tx')]);
    const run = track(s.fleet, s.queue, ['ta', 'tb', 'tx']);

    await s.memory.entered; // ta ya está `failed` y su ciclo sigue guardando la sesión
    expect(s.queue.state('ta')).toBe('failed');
    s.queue.retry('ta', 'reintento pedido por el usuario');
    await delay(20);
    expect(s.queue.state('ta')).toBe('ready');
    expect(s.fleet.inFlight()).toContain('ta');
    expect(s.authorPasses('ta')).toBe(1);

    s.memory.release();
    const report = await run.done;
    expect(run.at.states).toEqual({ ta: 'integrated', tb: 'integrated', tx: 'integrated' });
    expect(report.states).toEqual({ ta: 'integrated', tb: 'integrated', tx: 'integrated' });
    expect(s.authorPasses('ta')).toBe(2);
    expect(s.fleet.inFlight()).toEqual([]);
  });

  it('con concurrencia 1, run() no termina mientras corre la segunda pasada y luego arranca la tarea nueva', async () => {
    const s = await setup({ concurrency: 1, secondWaitMs: 200 });
    s.queue.add(brief('ta'));
    const run = track(s.fleet, s.queue, ['ta', 'td']);

    await s.memory.entered;
    s.queue.retry('ta', 'reintento pedido por el usuario');
    await delay(20);
    s.memory.release();
    await until(() => s.authorPasses('ta') === 2, 'segunda pasada de ta');
    await delay(30); // el primer ciclo ya cerró: la tarea nueva llega con la segunda pasada sola
    s.queue.add(brief('td'));
    await delay(50);
    expect(s.queue.state('ta')).toBe('running');
    expect(run.at.resolved).toBe(false);

    await run.done;
    expect(run.at.states).toEqual({ ta: 'integrated', td: 'integrated' });
  });
});

describe('FleetRuntime: sin relanzar la flota en bucle cuando no hay cupo', () => {
  it('una tarea lista sin cupo no hace que run() se relance sin fin', async () => {
    const s = await setup({ concurrency: 1, secondWaitMs: 0 });
    // Descuadre: la cola cuenta una tarea activa que ningún run() lleva (el único cupo está ocupado).
    s.queue.add(brief('fantasma'));
    expect(s.queue.next()?.id).toBe('fantasma');
    const realRun = s.fleet.run.bind(s.fleet);
    let runs = 0;
    s.fleet.run = (opts) => {
      runs++;
      // Corta el bucle de microtareas para que la prueba no cuelgue el proceso si la guardia falta.
      return runs > 20 ? new Promise<FleetReport>(() => undefined) : realRun(opts);
    };
    const runtime = new FleetRuntime({ queue: s.queue, fleet: s.fleet });

    expect(await runtime.delegate(brief('td'))).toMatchObject({ accepted: true, state: 'ready' });
    await delay(20);
    expect(runs).toBe(1);
    expect(s.queue.state('td')).toBe('ready');
  });
});
