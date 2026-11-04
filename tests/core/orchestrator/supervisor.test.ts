import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskQueue, type TaskStateChange } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor, summarizeAttempt, type AttemptResult } from '../../../src/core/orchestrator/supervisor.ts';
import { agentEventSchema, handoffSchema, REDACTED, type AgentAdapter, type AgentEvent, type Handoff } from '../../../src/shared/index.ts';
import { agents, delay, FakeQuota, FakeWorkspaces, MemorySink, ScriptedAdapter, task, writeHandoffFile, type Script } from './fakes.ts';

let workspaces: FakeWorkspaces;
let worktree: string;

beforeEach(async () => {
  workspaces = await FakeWorkspaces.create();
  worktree = (await workspaces.create('demo', task('t1'))).path;
});
afterEach(async () => {
  await workspaces.dispose();
});

function setup(scripts: { codex?: Script | Script[]; claude1?: Script | Script[]; claude2?: Script | Script[] }, extra: { env?: Record<string, string>; queue?: TaskQueue; maxAttempts?: number } = {}) {
  const sink = new MemorySink();
  const codexQuota = new FakeQuota('codex', 0.9);
  const router = new Router({ agents: [agents.claude1, agents.claude2, agents.codex], quotas: [codexQuota] });
  const adapters = {
    codex: new ScriptedAdapter(agents.codex, scripts.codex ?? []),
    claude1: new ScriptedAdapter(agents.claude1, scripts.claude1 ?? []),
    claude2: new ScriptedAdapter(agents.claude2, scripts.claude2 ?? []),
  };
  const handoffs: Handoff[] = [];
  const supervisor = new Supervisor({
    adapters: Object.values(adapters),
    router,
    sink,
    queue: extra.queue,
    env: (id) => (id === 'codex' ? extra.env ?? {} : {}),
    onHandoff: (h) => { handoffs.push(h); },
    graceMs: 30,
    maxAttempts: extra.maxAttempts,
  });
  return { sink, router, adapters, supervisor, handoffs, codexQuota };
}

function expectNoLeases(router: Router): void {
  for (const id of ['claude-1', 'claude-2', 'codex']) expect(router.load(id), `arriendo de ${id}`).toBe(0);
}

describe('Supervisor.runAttempt', () => {
  it('reenvía cada evento al sink, validado y con los secretos tachados', async () => {
    const secret = 'valor-de-clave-123456';
    const { sink, supervisor } = setup({
      codex: [
        { text: `Uso sk-ant-api03-abcdefghijklmnopqrst y ${secret}` },
        { file: 'src/a.ts', change: 'add' },
        { usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.01 } },
        { usage: { inputTokens: 800, outputTokens: 100 } },
        { done: true, summary: 'listo' },
      ],
    }, { env: { CODEX_TOKEN: secret } });
    const result = await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree });

    expect(result).toMatchObject({ ok: true, outcome: 'ok', summary: 'listo', filesChanged: ['src/a.ts'], usage: { inputTokens: 2000, outputTokens: 400, costUsd: 0.01 } });
    expect(sink.events.map((e) => e.type)).toEqual(['status', 'text', 'file_change', 'usage', 'usage', 'done']);
    for (const e of sink.events) expect(agentEventSchema.safeParse(e).success).toBe(true);
    const text = JSON.stringify(sink.events);
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain(secret);
    expect(text).toContain(REDACTED);
    expect(result.texts.join(' ')).not.toContain(secret);
  });

  it('un evento mal formado se convierte en raw en lugar de romper la sesión', async () => {
    const { sink, supervisor } = setup({ codex: [{ invalid: { type: 'text', payload: { nope: 1 } } }, { done: true }] });
    const result = await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree });
    expect(result.ok).toBe(true);
    const raw = sink.events.find((e) => e.type === 'raw');
    expect(raw).toMatchObject({ agentId: 'codex', payload: { source: 'supervisor:evento-invalido' } });
  });

  it('aplica el plazo aunque el adaptador se cuelgue e ignore la señal', async () => {
    const { sink, supervisor } = setup({ codex: [{ text: 'empiezo' }, { hang: true }] });
    const started = Date.now();
    const result = await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree, timeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ ok: false, outcome: 'timeout', error: { code: 'timeout' } });
    const tail = sink.events.slice(-2);
    expect(tail.map((e) => e.type)).toEqual(['error', 'done']);
    expect(tail[0]).toMatchObject({ sessionId: 'codex-s1', payload: { code: 'timeout' } });
    expect(tail[1]?.seq).toBeGreaterThan(tail[0]?.seq ?? Infinity);
  });

  it('un adaptador que coopera cierra solo: sin eventos duplicados', async () => {
    const { sink, supervisor } = setup({ codex: [{ untilAbort: true }, { error: 'timeout', message: 'Codex terminó' }, { done: false }] });
    const result = await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree, timeoutMs: 30 });
    expect(result.outcome).toBe('timeout');
    expect(sink.events.map((e) => e.type)).toEqual(['status', 'error', 'done']);
  });

  it('cancela con la señal externa y avisa al adaptador', async () => {
    const { adapters, sink, supervisor } = setup({ codex: [{ untilAbort: true }, { error: 'cancelled' }, { done: false }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree, signal: controller.signal });
    expect(result.outcome).toBe('cancelled');
    expect(adapters.codex.calls[0]?.ctx.signal.aborted).toBe(true);
    expect(sink.events.filter((e) => e.type === 'error').map((e) => e.type === 'error' && e.payload.code)).toEqual(['cancelled']);
  });

  it('un adaptador que termina sin done o que lanza cuenta como crash', async () => {
    const { sink, supervisor } = setup({ codex: [[{ text: 'a medias' }], () => { throw new Error('se rompió'); }] });
    const first = await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree });
    expect(first).toMatchObject({ outcome: 'failed', error: { code: 'crash', message: expect.stringContaining('sin evento done') } });
    expect(sink.events.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
    const second = await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree });
    expect(second).toMatchObject({ outcome: 'failed', error: { code: 'crash', message: expect.stringContaining('se rompió') } });
  });

  it('done.ok = true con error de cupo se trata como cupo agotado', async () => {
    const { supervisor } = setup({ codex: [{ error: 'quota_exhausted', message: 'usage limit' }, { done: true }] });
    expect((await supervisor.runAttempt(task('t1'), 'codex', { worktreePath: worktree })).outcome).toBe('quota_exhausted');
  });
});

describe('Supervisor.execute: traspasos', () => {
  it('Codex agota el cupo a mitad de tarea → Claude continúa en el mismo worktree con el resumen y HANDOFF.md', async () => {
    const queue = new TaskQueue();
    const changes: TaskStateChange[] = [];
    queue.on((c) => changes.push(c));
    queue.add(task('t1'));
    queue.next();
    const { adapters, router, sink, supervisor, handoffs, codexQuota } = setup({
      codex: [
        { text: 'Leo el código y empiezo el parser.' },
        { file: 'src/t1/parser.ts', change: 'add' },
        { effect: (ctx) => writeHandoffFile(ctx, '# Traspaso\nHecho: parser.\nPendiente: pruebas de errores.') },
        { text: 'Parser listo; faltan las pruebas.' },
        { usage: { inputTokens: 5000, outputTokens: 800 } },
        { error: 'quota_exhausted', message: "You've hit your usage limit." },
        { done: false },
      ],
      claude1: (_task, ctx) => [{ text: `Sigo desde ${ctx.handoff?.fromAgent ?? '?'}` }, { file: 'tests/t1/parser.test.ts', change: 'add' }, { done: true, summary: 'Pruebas agregadas' }],
    }, { queue });
    router.acquire('codex'); // arriendo de route()

    const result = await supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: worktree });

    expect(result).toMatchObject({ ok: true, outcome: 'ok', agentId: 'claude-1', authors: ['codex', 'claude-1'] });
    expect(result.attempts.map((a) => [a.agentId, a.outcome])).toEqual([['codex', 'quota_exhausted'], ['claude-1', 'ok']]);
    const claudeCall = adapters.claude1.calls[0];
    expect(claudeCall?.ctx.worktreePath).toBe(worktree);
    expect(adapters.codex.calls[0]?.ctx.worktreePath).toBe(worktree);

    const handoff = handoffSchema.parse(claudeCall?.ctx.handoff);
    expect(handoff).toMatchObject({ taskId: 't1', fromAgent: 'codex', toAgent: 'claude-1', reason: 'quota_exhausted', worktreePath: worktree });
    expect(handoff.partialSummary).toContain('Parser listo; faltan las pruebas.');
    expect(handoff.partialSummary).toContain('Pendiente: pruebas de errores.');
    expect(handoff.partialSummary).toContain('src/t1/parser.ts');
    expect(handoffs).toEqual([handoff]);
    expect(result.handoffs).toEqual([handoff]);

    expect(changes.slice(-2).map((c) => `${c.from}→${c.to}:${c.agentId}`)).toEqual(['running→handed_off:codex', 'handed_off→running:claude-1']);
    expect(sink.of('codex').at(-1)).toMatchObject({ type: 'done' });
    expect(sink.of('claude-1').length).toBeGreaterThan(0);
    codexQuota.stale = true; // la lectura antigua aún dice 90 %, pero el agente agotó el cupo
    expect((await router.checkQuota('codex')).allowed).toBe(false);
    expectNoLeases(router);
    expect(await readFile(join(worktree, '.orq', 'HANDOFF.md'), 'utf8')).toContain('Hecho: parser.');
  });

  it('un fallo vuelve al mismo agente; dos seguidos reasignan a Claude', async () => {
    const fail = [{ text: 'intento' }, { error: 'crash' as const, message: 'exit 1' }, { done: false }];
    const { adapters, router, supervisor } = setup({ codex: fail, claude1: [{ done: true, summary: 'arreglado' }] });
    router.acquire('codex');
    const result = await supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: worktree });
    expect(result.attempts.map((a) => a.agentId)).toEqual(['codex', 'codex', 'claude-1']);
    expect(result.ok).toBe(true);
    // El reintento lleva el resumen del primer fallo.
    expect(adapters.codex.calls[1]?.ctx.handoff).toMatchObject({ fromAgent: 'codex', toAgent: 'codex', reason: 'failure' });
    expect(result.handoffs).toEqual([expect.objectContaining({ fromAgent: 'codex', toAgent: 'claude-1', reason: 'failure' })]);
    expect(adapters.claude1.calls[0]?.ctx.worktreePath).toBe(worktree);
    expectNoLeases(router);
  });

  it('si el que falla dos veces ya es Claude, pasa a otra instancia de Claude', async () => {
    const fail = [{ error: 'timeout' as const }, { done: false }];
    const { router, supervisor } = setup({ claude1: fail, claude2: [{ done: true }] });
    router.acquire('claude-1');
    const result = await supervisor.execute(task('t1'), { agentId: 'claude-1', worktreePath: worktree });
    expect(result.attempts.map((a) => a.agentId)).toEqual(['claude-1', 'claude-1', 'claude-2']);
    expect(result.handoffs[0]?.reason).toBe('timeout');
    expectNoLeases(router);
  });

  it('se rinde tras maxAttempts y libera los arriendos', async () => {
    const fail = [{ error: 'crash' as const }, { done: false }];
    const { router, supervisor } = setup({ codex: fail, claude1: fail, claude2: fail }, { maxAttempts: 3 });
    router.acquire('codex');
    const result = await supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: worktree });
    expect(result).toMatchObject({ ok: false, outcome: 'failed', error: expect.stringContaining('3 intentos') });
    expect(result.attempts).toHaveLength(3);
    expectNoLeases(router);
  });

  it('sin Claude que reciba el traspaso, falla con el motivo', async () => {
    const sink = new MemorySink();
    const router = new Router({ agents: [agents.codex] });
    const codex = new ScriptedAdapter(agents.codex, [{ error: 'quota_exhausted' }, { done: false }]);
    const supervisor = new Supervisor({ adapters: [codex], router, sink });
    router.acquire('codex');
    const result = await supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: worktree });
    expect(result).toMatchObject({ ok: false, outcome: 'failed', error: expect.stringContaining('No hay instancias de Claude') });
    expect(router.load('codex')).toBe(0);
  });

  it('un traspaso de revisión no cae en un autor excluido', async () => {
    const { router, supervisor } = setup({ codex: [{ error: 'quota_exhausted' }, { done: false }], claude2: [{ done: true }] });
    router.acquire('codex');
    const result = await supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: worktree, exclude: ['claude-1'] });
    expect(result.agentId).toBe('claude-2');
    expectNoLeases(router);
  });

  it('la cancelación detiene la tarea sin reintentos', async () => {
    const { adapters, router, supervisor } = setup({ codex: [{ untilAbort: true }, { error: 'cancelled' }, { done: false }] });
    router.acquire('codex');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: worktree, signal: controller.signal });
    expect(result.outcome).toBe('cancelled');
    expect(adapters.codex.calls).toHaveLength(1);
    expectNoLeases(router);
  });

  it('llama a beforeAttempt antes de cada intento con el traspaso vigente', async () => {
    const { router, supervisor } = setup({ codex: [{ error: 'quota_exhausted' }, { done: false }], claude1: [{ done: true }] });
    router.acquire('codex');
    const seen: string[] = [];
    await supervisor.execute(task('t1'), {
      agentId: 'codex', worktreePath: worktree,
      beforeAttempt: (info) => { seen.push(`${info.attempt}:${info.agentId}:${info.handoff?.reason ?? '-'}`); },
    });
    expect(seen).toEqual(['1:codex:-', '2:claude-1:quota_exhausted']);
  });
});

describe('Supervisor: hallazgos de la revisión de Codex', () => {
  it('un return() del adaptador que nunca termina no cuelga execute() ni retiene el arriendo (hallazgo 1)', async () => {
    const sink = new MemorySink();
    const router = new Router({ agents: [agents.claude1] });
    const stuck: AgentAdapter = {
      config: agents.claude1,
      probe: async () => ({ agentId: 'claude-1', installed: true, authenticated: true, models: [], quotaMethod: 'none', warnings: [] }),
      run: (t, ctx) => {
        const events = [
          { sessionId: 's', agentId: 'claude-1', seq: 0, ts: new Date().toISOString(), type: 'status', payload: { state: 'running' } },
          { sessionId: 's', agentId: 'claude-1', seq: 1, ts: new Date().toISOString(), type: 'done', payload: { ok: true, summary: `${t.id} en ${ctx.worktreePath}` } },
        ] as AgentEvent[];
        let i = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => (i < events.length ? { done: false as const, value: events[i++] as AgentEvent } : { done: true as const, value: undefined }),
              return: () => new Promise<IteratorResult<AgentEvent>>(() => undefined), // el cierre se cuelga
            };
          },
        };
      },
    };
    const supervisor = new Supervisor({ adapters: [stuck], router, sink, graceMs: 30 });
    router.acquire('claude-1');
    const outcome = await Promise.race([
      supervisor.execute(task('t1'), { agentId: 'claude-1', worktreePath: worktree }),
      delay(3_000).then(() => 'colgado' as const),
    ]);
    expect(outcome).not.toBe('colgado');
    expect(outcome).toMatchObject({ ok: true, outcome: 'ok' });
    expect(router.load('claude-1')).toBe(0);
  });

  it('el último intento con quota_exhausted también bloquea al agente (hallazgo 4)', async () => {
    const sink = new MemorySink();
    const router = new Router({ agents: [agents.claude1, agents.codex] }); // Codex sin proveedor: solo el bloqueo lo frena
    const codex = new ScriptedAdapter(agents.codex, [{ error: 'quota_exhausted' }, { done: false }]);
    const supervisor = new Supervisor({ adapters: [codex], router, sink, maxAttempts: 1 });
    router.acquire('codex');
    const result = await supervisor.execute(task('t1'), { agentId: 'codex', worktreePath: worktree });
    expect(result.outcome).toBe('failed');
    expect((await router.checkQuota('codex')).allowed).toBe(false);
    expect((await router.route(task('t2'))).agentId).toBe('claude-1');
  });
});

describe('summarizeAttempt', () => {
  it('recorta respetando el presupuesto y tacha secretos', () => {
    const attempt: AttemptResult = {
      agentId: 'codex', sessionId: 's', outcome: 'quota_exhausted', ok: false,
      error: { code: 'quota_exhausted', message: 'limit' },
      texts: ['x'.repeat(5_000), 'final con sk-ant-api03-abcdefghijklmnopqrst'],
      filesChanged: ['a.ts'], usage: { inputTokens: 0, outputTokens: 0 }, events: 3, startedAt: '', endedAt: '',
    };
    const text = summarizeAttempt(attempt, { handoffFile: 'Pendiente: todo', maxChars: 800 });
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain('Pendiente: todo');
    expect(text).toContain('final con');
    expect(text).not.toContain('sk-ant-api03');
  });
});
