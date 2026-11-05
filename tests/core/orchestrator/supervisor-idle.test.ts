import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { DEFAULT_MAX_RUN_MS, DEFAULT_TIMEOUT_MS, Supervisor, formatDuration } from '../../../src/core/orchestrator/supervisor.ts';
import type { AgentEvent, TaskBrief } from '../../../src/shared/index.ts';
import { agents, MemorySink, ScriptedAdapter, task, type Step } from './fakes.ts';

const MIN = 60_000;

/** Un evento cada `everyMs` durante `totalMs` y luego `done`. */
function steadyScript(everyMs: number, totalMs: number, done = true): Step[] {
  const steps: Step[] = [];
  for (let t = 0; t < totalMs; t += everyMs) steps.push({ wait: everyMs }, { text: `avance a los ${(t + everyMs) / MIN} min` });
  if (done) steps.push({ done: true, summary: 'terminé' });
  return steps;
}

function setup(script: Step[], opts: { timeoutMs?: number; maxRunMs?: number } = {}) {
  const sink = new MemorySink();
  const seen: { event: AgentEvent; task: TaskBrief }[] = [];
  const adapter = new ScriptedAdapter(agents.codex, script);
  const supervisor = new Supervisor({
    adapters: [adapter],
    router: new Router({ agents: [agents.codex], quotas: [] }),
    sink,
    graceMs: 30,
    onEvent: (event, t) => {
      seen.push({ event, task: t });
    },
    ...opts,
  });
  return { sink, adapter, supervisor, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Supervisor: plazo por inactividad', () => {
  it('por defecto: 60 min de inactividad y tope de 3 h', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60 * MIN);
    expect(DEFAULT_MAX_RUN_MS).toBe(180 * MIN);
    expect([formatDuration(40), formatDuration(30_000), formatDuration(60 * MIN), formatDuration(180 * MIN), formatDuration(90 * MIN)]).toEqual([
      '40 ms', '30 s', '60 min', '3 h', '1 h 30 min',
    ]);
  });

  it('un agente que emite un evento cada minuto no se corta a los 60 min (termina a los 90)', async () => {
    const { supervisor, adapter, seen } = setup(steadyScript(MIN, 90 * MIN));
    const run = supervisor.runAttempt(task('t1'), 'codex', { worktreePath: 'C:\\wt\\t1' });
    await vi.advanceTimersByTimeAsync(91 * MIN);
    const result = await run;
    expect(result).toMatchObject({ ok: true, outcome: 'ok', summary: 'terminé' });
    // El adaptador recibe el tope absoluto como plazo total propio; la inactividad la vigila el Supervisor.
    expect(adapter.calls[0]?.ctx.timeoutMs).toBe(DEFAULT_MAX_RUN_MS);
    // Cada evento llega al observador con la tarea de la ejecución.
    expect(seen.length).toBeGreaterThan(90);
    expect(new Set(seen.map((s) => s.task.id))).toEqual(new Set(['t1']));
    expect(seen.at(-1)?.event.type).toBe('done');
  });

  it('uno callado 60 min sí se corta, con el motivo de inactividad', async () => {
    const { supervisor, sink } = setup([{ text: 'empiezo' }, { wait: 59 * MIN }, { text: 'sigo' }, { hang: true }]);
    const run = supervisor.runAttempt(task('t2'), 'codex', { worktreePath: 'C:\\wt\\t2' });
    // A los 100 min: 59 min hasta «sigo» (el plazo se reinicia) + 60 min callado vencen a los 119 min.
    await vi.advanceTimersByTimeAsync(100 * MIN);
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    const result = await run;
    expect(result).toMatchObject({ ok: false, outcome: 'timeout', error: { code: 'timeout' } });
    expect(result.error?.message).toBe('Sin actividad del agente durante 60 min (plazo por inactividad).');
    expect(sink.events.at(-2)).toMatchObject({ type: 'error', payload: { code: 'timeout', message: expect.stringContaining('inactividad') } });
  });

  it('el plazo de inactividad se puede acortar (N min) por ejecución', async () => {
    const { supervisor } = setup([{ text: 'empiezo' }, { hang: true }]);
    const run = supervisor.runAttempt(task('t3'), 'codex', { worktreePath: 'C:\\wt\\t3', timeoutMs: 15 * MIN });
    await vi.advanceTimersByTimeAsync(15 * MIN + 100);
    const result = await run;
    expect(result.outcome).toBe('timeout');
    expect(result.error?.message).toMatch(/durante 15 min/);
  });

  it('el tope absoluto corta aunque el agente siga activo', async () => {
    const { supervisor, adapter } = setup(steadyScript(MIN, 240 * MIN), { maxRunMs: 120 * MIN });
    const run = supervisor.runAttempt(task('t4'), 'codex', { worktreePath: 'C:\\wt\\t4' });
    await vi.advanceTimersByTimeAsync(121 * MIN);
    const result = await run;
    expect(result).toMatchObject({ ok: false, outcome: 'timeout' });
    expect(result.error?.message).toBe('Tope de 2 h por ejecución vencido.');
    expect(adapter.calls[0]?.ctx.timeoutMs).toBe(120 * MIN);
  });

  it('un observador que falla no rompe la ejecución', async () => {
    const sink = new MemorySink();
    const supervisor = new Supervisor({
      adapters: [new ScriptedAdapter(agents.codex, [{ text: 'hola' }, { done: true }])],
      router: new Router({ agents: [agents.codex], quotas: [] }),
      sink,
      onEvent: () => {
        throw new Error('observador roto');
      },
    });
    const run = supervisor.runAttempt(task('t5'), 'codex', { worktreePath: 'C:\\wt\\t5' });
    await vi.advanceTimersByTimeAsync(10);
    expect((await run).ok).toBe(true);
    expect(sink.events.map((e) => e.type)).toEqual(['status', 'text', 'done']);
  });
});
