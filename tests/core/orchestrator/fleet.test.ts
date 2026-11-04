import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewTask, Fleet, parseReviewVerdict, withFeedback } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue, type TaskStateChange } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import { agentEventSchema, type AgentConfig, type QuotaProvider, type TaskBrief } from '../../../src/shared/index.ts';
import {
  agents,
  agyFixtureQuota,
  codexFixtureUsage,
  ConcurrencyTracker,
  FakeMemory,
  FakeQuota,
  FakeWorkspaces,
  MemorySink,
  okScript,
  ScriptedAdapter,
  delay,
  task,
  verdictScript,
  writeHandoffFile,
  type Script,
  type Step,
} from './fakes.ts';

const disposables: FakeWorkspaces[] = [];
afterEach(async () => {
  for (const w of disposables.splice(0)) await w.dispose();
});

const isReview = (t: TaskBrief) => t.id.endsWith('-revision');

async function setup(opts: {
  agents: AgentConfig[];
  scripts: Record<string, Script | Script[]>;
  quotas?: QuotaProvider[];
  concurrency?: number;
  maxAttempts?: number;
  tracker?: ConcurrencyTracker;
}) {
  const workspaces = await FakeWorkspaces.create();
  disposables.push(workspaces);
  const queue = new TaskQueue({ concurrency: opts.concurrency });
  const changes: TaskStateChange[] = [];
  queue.on((c) => changes.push(c));
  const router = new Router({ agents: opts.agents, quotas: opts.quotas });
  const sink = new MemorySink();
  const adapters = new Map(opts.agents.map((a) => [a.id, new ScriptedAdapter(a, opts.scripts[a.id] ?? [], opts.tracker)]));
  const supervisor = new Supervisor({ adapters: adapters.values(), router, sink, queue, graceMs: 30, maxAttempts: opts.maxAttempts });
  const memory = new FakeMemory();
  const writes: { path: string; content: string }[] = [];
  const warnings: string[] = [];
  const fleet = new Fleet({
    queue, router, supervisor, workspaces, memory,
    writeFile: async (path, content) => {
      writes.push({ path, content });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    warn: (m) => warnings.push(m),
  });
  const adapter = (id: string): ScriptedAdapter => {
    const a = adapters.get(id);
    if (!a) throw new Error(`sin adaptador ${id}`);
    return a;
  };
  const transitions = (taskId: string) => changes.filter((c) => c.taskId === taskId).map((c) => `${c.from ?? '∅'}→${c.to}${c.agentId ? `@${c.agentId}` : ''}`);
  const expectNoLeases = () => {
    for (const a of opts.agents) expect(router.load(a.id), `arriendo de ${a.id}`).toBe(0);
  };
  return { workspaces, queue, changes, router, sink, supervisor, memory, writes, warnings, fleet, adapter, transitions, expectNoLeases };
}

describe('Fleet: traspaso por cupo de punta a punta', () => {
  it('Codex agota el cupo a mitad de tarea → Claude termina en el mismo worktree → revisa otro agente → se integra', async () => {
    const usage = await codexFixtureUsage(); // consumo real de un `codex exec --json`
    const s = await setup({
      agents: [agents.claude1, agents.codex, agents.agy],
      quotas: [new FakeQuota('codex', 0.9), await agyFixtureQuota()],
      scripts: {
        codex: [
          { text: 'Empiezo por el parser.' },
          { file: 'src/parser/index.ts', change: 'add' },
          { usage },
          { effect: (ctx) => writeHandoffFile(ctx, '# Traspaso\nHecho: parser.\nPendiente: pruebas.') },
          { text: 'Parser listo; faltan las pruebas.' },
          { error: 'quota_exhausted', message: "You've hit your usage limit. Try again later." },
          { done: false },
        ],
        'claude-1': (t, ctx) => isReview(t)
          ? verdictScript('aprobado')
          : [{ text: `Continúo lo de ${ctx.handoff?.fromAgent ?? '?'}` }, { file: 'tests/parser/index.test.ts', change: 'add' }, { usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.02 } }, { done: true, summary: 'Pruebas del parser agregadas' }],
        agy: verdictScript('aprobado'),
      },
    });
    s.queue.add(task('parser', { suggestedAgent: 'codex' }));

    const report = await s.fleet.run();

    const r = report.tasks[0];
    expect(report.states).toEqual({ parser: 'integrated' });
    expect(r).toMatchObject({ taskId: 'parser', state: 'integrated', authors: ['codex', 'claude-1'], rounds: 1, review: { veredicto: 'aprobado' } });
    // El revisor no es ninguno de los autores (Claude fue autor: revisa agy, con el cupo real de fixtures).
    expect(r?.reviewers).toEqual(['agy']);

    // Mismo worktree para Codex, Claude y el revisor.
    const ws = s.workspaces.created[0];
    expect(ws).toBeDefined();
    const codexCtx = s.adapter('codex').calls[0]?.ctx;
    const claudeCall = s.adapter('claude-1').calls[0];
    expect(codexCtx?.worktreePath).toBe(ws?.path);
    expect(claudeCall?.ctx.worktreePath).toBe(ws?.path);
    expect(s.adapter('agy').calls[0]?.ctx.worktreePath).toBe(ws?.path);

    // El traspaso lleva el resumen de los últimos textos y .orq/HANDOFF.md.
    expect(claudeCall?.ctx.handoff).toMatchObject({ fromAgent: 'codex', toAgent: 'claude-1', reason: 'quota_exhausted', worktreePath: ws?.path });
    expect(claudeCall?.ctx.handoff?.partialSummary).toContain('Parser listo; faltan las pruebas.');
    expect(claudeCall?.ctx.handoff?.partialSummary).toContain('Pendiente: pruebas.');
    expect(r?.handoffs).toHaveLength(1);

    // Encargo escrito en .orq/BRIEF.md (precedido de .orq/PLAN.md): con memoria, luego con la continuación y luego la revisión.
    const briefPath = join(ws?.path ?? '', '.orq', 'BRIEF.md');
    const planPath = join(ws?.path ?? '', '.orq', 'PLAN.md');
    expect(s.writes.map((w) => w.path)).toEqual([planPath, briefPath, planPath, briefPath, planPath, briefPath]);
    const briefs = s.writes.filter((w) => w.path === briefPath);
    expect(briefs[0]?.content).toContain('Contexto de memoria para parser');
    expect(briefs[0]?.content).not.toContain('Continuación de otro agente');
    expect(briefs[1]?.content).toContain('Continuación de otro agente');
    expect(briefs[1]?.content).toContain('`codex`');
    expect(briefs[2]?.content).toContain('# Tarea parser-revision: Revisión: Tarea parser');
    expect(briefs[2]?.content).toContain('src/parser/index.ts'); // resumen del diff
    expect(s.memory.contextRequests).toEqual([{ projectId: 'demo', taskId: 'parser', budget: 4_000 }]);

    // Estados de la cola.
    expect(s.transitions('parser')).toEqual([
      '∅→pending', 'pending→ready', 'ready→running', 'running→handed_off@codex', 'handed_off→running@claude-1', 'running→review@claude-1', 'review→integrated@claude-1',
    ]);

    // Memoria: una sesión por autor.
    expect(s.memory.sessions.map((x) => [x.agentId, x.outcome])).toEqual([['codex', 'handed_off'], ['claude-1', 'ok']]);
    expect(s.memory.sessions[0]).toMatchObject({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, filesChanged: ['src/parser/index.ts'] });
    expect(s.memory.sessions[1]).toMatchObject({ summary: 'Pruebas del parser agregadas', costUsd: 0.02, filesChanged: ['tests/parser/index.test.ts'] });

    // Integración y limpieza.
    expect(s.workspaces.integrated).toEqual(['parser']);
    expect(s.workspaces.removed).toEqual(['parser']);
    // Eventos de los tres agentes en el sink, todos válidos.
    expect(new Set(s.sink.events.map((e) => e.agentId))).toEqual(new Set(['codex', 'claude-1', 'agy']));
    for (const e of s.sink.events) expect(agentEventSchema.safeParse(e).success).toBe(true);
    s.expectNoLeases();
  });
});

describe('Fleet: revisión cruzada e integración', () => {
  it('un rechazo devuelve la tarea al autor con las observaciones', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: {
        codex: [okScript('v1', 'src/api/a.ts'), okScript('v2', 'src/api/a.test.ts')],
        'claude-1': [verdictScript('rechazado', ['Falta la prueba de errores']), verdictScript('aprobado')],
      },
    });
    s.queue.add(task('api'));
    const report = await s.fleet.run();
    const r = report.tasks[0];
    expect(r).toMatchObject({ state: 'integrated', authors: ['codex'], reviewers: ['claude-1'], rounds: 2 });
    const second = s.adapter('codex').calls[1];
    expect(second?.task.objective).toContain('Falta la prueba de errores');
    expect(second?.task.objective).toContain('revisión de claude-1');
    expect(second?.ctx.worktreePath).toBe(s.adapter('codex').calls[0]?.ctx.worktreePath);
    expect(s.transitions('api')).toContain('review→running@codex');
    for (const call of s.adapter('claude-1').calls) expect(call.task.id).toBe('api-revision');
    s.expectNoLeases();
  });

  it('dos fallos seguidos de integración reasignan la tarea a Claude con el resultado del gate', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: {
        codex: okScript('hecho', 'src/gate/a.ts'),
        'claude-1': (t) => (isReview(t) ? verdictScript('aprobado') : okScript('corregido por Claude')),
        'claude-2': (t) => (isReview(t) ? verdictScript('aprobado') : okScript('corregido por Claude')),
      },
    });
    const gateFail = { ok: false, conflicts: [], gateSummary: 'npm run gate: 2 pruebas fallidas' };
    s.workspaces.integrationScript.set('gate', [gateFail, gateFail]);
    s.queue.add(task('gate'));

    const r = (await s.fleet.run()).tasks[0];

    expect(r?.state).toBe('integrated');
    expect(r?.rounds).toBe(3);
    expect(s.adapter('codex').calls).toHaveLength(2); // el primer fallo vuelve al autor
    const finalAuthor = r?.authors.at(-1) ?? '';
    expect(r?.authors[0]).toBe('codex');
    expect(s.router.isClaude(finalAuthor)).toBe(true);
    const claudeCall = s.adapter(finalAuthor).calls.find((c) => !isReview(c.task));
    expect(claudeCall?.task.objective).toContain('npm run gate: 2 pruebas fallidas');
    expect(claudeCall?.ctx.handoff).toMatchObject({ fromAgent: 'codex', toAgent: finalAuthor, reason: 'failure' });
    // En cada ronda, el revisor no es ninguno de los autores hasta ese momento.
    const calls = ['claude-1', 'claude-2', 'codex'].flatMap((id) => s.adapter(id).calls).sort((a, b) => a.order - b.order);
    const authorsSoFar = new Set<string>();
    let reviews = 0;
    for (const call of calls) {
      if (isReview(call.task)) {
        reviews++;
        expect(authorsSoFar.has(call.agentId), `${call.agentId} revisó su propio trabajo`).toBe(false);
      } else {
        authorsSoFar.add(call.agentId);
      }
    }
    expect(reviews).toBe(3);
    s.expectNoLeases();
  });

  it('la revisión no toca la cola aunque su id coincida con otra tarea, y avisa si el revisor edita el proyecto', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: {
        codex: (t) => (t.id === 'login' ? okScript('login hecho') : verdictScript('aprobado')),
        // El revisor de «login» agota su presupuesto: traspaso de la revisión (id login-revision), no de la tarea real.
        'claude-1': (t) => (t.id === 'login-revision' ? [{ file: 'src/login/x.ts' }, { error: 'quota_exhausted' }, { done: false }] : verdictScript('aprobado')),
        // Autora de la tarea real «login-revision»: sigue en `running` mientras ocurre el traspaso de la revisión.
        'claude-2': (_t, ctx) => (ctx.handoff ? verdictScript('aprobado') : [{ wait: 150 }, ...verdictScript('aprobado')]),
      },
    });
    s.queue.addAll([task('login'), task('login-revision', { ownedPaths: ['src/otra/**'], difficulty: 'high', suggestedAgent: 'claude-2' })]);
    const report = await s.fleet.run();
    expect(report.states).toEqual({ login: 'integrated', 'login-revision': 'integrated' });
    expect(s.transitions('login-revision').filter((x) => x.includes('handed_off'))).toEqual([]);
    expect(s.warnings.join(' ')).toMatch(/el revisor .* modificó archivos del proyecto: src\/login\/x\.ts/);
    s.expectNoLeases();
  });

  it('si un revisor no entrega veredicto, revisa otro agente', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: {
        codex: okScript('hecho'),
        'claude-1': [{ text: 'Todo se ve bien.' }, { done: true }],
        'claude-2': verdictScript('aprobado'),
      },
    });
    s.queue.add(task('sinveredicto'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r).toMatchObject({ state: 'integrated', reviewers: ['claude-1', 'claude-2'] });
    expect(s.warnings.join(' ')).toMatch(/claude-1 no entregó un veredicto válido/);
  });

  it('un fallo definitivo deja la tarea fallida, conserva el worktree y bloquea a sus dependientes', async () => {
    const fail = [{ error: 'crash' as const, message: 'exit 1' }, { done: false }];
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      maxAttempts: 2,
      scripts: { codex: fail, 'claude-1': fail },
    });
    s.queue.addAll([task('base'), task('encima', { dependsOn: ['base'] })]);
    const report = await s.fleet.run();
    expect(report.states).toEqual({ base: 'failed', encima: 'pending' });
    expect(report.tasks[0]?.detail).toMatch(/sin éxito tras 2 intentos/);
    expect(s.workspaces.removed).toEqual([]);
    expect(s.memory.sessions.map((x) => x.outcome)).toEqual(['failed']);
    s.expectNoLeases();
  });
});

describe('Fleet: hallazgos de la revisión de Codex', () => {
  it('cancelar durante integrate() que termina bien deja la tarea integrada (punto de compromiso, hallazgo 2)', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: { codex: okScript('hecho'), 'claude-1': verdictScript('aprobado') },
    });
    let cancelled: boolean | undefined;
    s.workspaces.duringIntegrate = async (ws) => {
      if (ws.taskId !== 'base') return;
      cancelled = s.fleet.cancel('base');
      await delay(20);
    };
    s.queue.addAll([task('base'), task('encima', { dependsOn: ['base'] })]);
    const report = await s.fleet.run();
    expect(cancelled).toBe(false); // ya estaba comprometida
    expect(report.states).toEqual({ base: 'integrated', encima: 'integrated' });
    expect(s.workspaces.integrated).toEqual(['base', 'encima']);
    expect(s.warnings.join(' ')).toMatch(/base: se está integrando; la cancelación se ignora/);
    s.expectNoLeases();
  });

  it('cancelar antes del punto de compromiso no integra', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: {
        codex: okScript('hecho'),
        'claude-1': [{ effect: () => { s.fleet.cancel('base'); } }, ...verdictScript('aprobado')],
      },
    });
    s.queue.addAll([task('base'), task('encima', { dependsOn: ['base'] })]);
    const report = await s.fleet.run();
    expect(report.states).toEqual({ base: 'cancelled', encima: 'cancelled' });
    expect(s.workspaces.integrated).toEqual([]);
    s.expectNoLeases();
  });

  it('cancelar durante una integración que falla sí cancela la tarea', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: { codex: okScript('hecho'), 'claude-1': verdictScript('aprobado') },
    });
    s.workspaces.integrationScript.set('base', [{ ok: false, conflicts: ['src/a.ts'], gateSummary: '' }]);
    s.workspaces.duringIntegrate = () => { s.fleet.cancel('base'); };
    s.queue.add(task('base'));
    const report = await s.fleet.run();
    expect(report.states).toEqual({ base: 'cancelled' });
    expect(s.adapter('codex').calls).toHaveLength(1); // no vuelve al autor
    s.expectNoLeases();
  });

  it('la racha de fallos de integración se reinicia cuando cambia el autor efectivo (hallazgo 5)', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: {
        // Ronda 1: Codex termina; ronda 2: Codex agota el cupo y sigue un Claude dentro de execute().
        codex: [okScript('v1'), [{ text: 'sigo' }, { error: 'quota_exhausted' }, { done: false }]],
        'claude-1': (t) => (isReview(t) ? verdictScript('aprobado') : okScript('corregido')),
        'claude-2': (t) => (isReview(t) ? verdictScript('aprobado') : okScript('corregido')),
      },
    });
    const gateFail = { ok: false, conflicts: [], gateSummary: 'gate rojo' };
    s.workspaces.integrationScript.set('racha', [gateFail, gateFail]);
    s.queue.add(task('racha'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('integrated');
    // Un solo Claude se hizo cargo: su primer fallo de integración no cuenta como segundo.
    expect(r?.authors).toHaveLength(2);
    expect(r?.handoffs.map((h) => h.reason)).toEqual(['quota_exhausted']);
    s.expectNoLeases();
  });
});

describe('Fleet: concurrencia y dependencias', () => {
  it('respeta el límite de concurrencia y no empieza una tarea antes de integrar sus dependencias', async () => {
    const tracker = new ConcurrencyTracker();
    const work = (t: TaskBrief): Step[] => (isReview(t) ? verdictScript('aprobado') : [{ wait: 60 }, ...okScript(t.id)]);
    const s = await setup({
      agents: [agents.claude1, agents.claude2, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      concurrency: 2,
      tracker,
      scripts: { 'claude-1': work, 'claude-2': work, codex: work },
    });
    s.queue.addAll([
      task('ta', { difficulty: 'high' }),
      task('tb', { difficulty: 'high' }),
      task('tc'),
      task('td', { dependsOn: ['ta', 'tb'] }),
      task('te', { dependsOn: ['td'] }),
    ]);

    let active = 0;
    let maxActive = 0;
    const activeStates = new Set(['running', 'handed_off', 'review']);
    s.queue.on((c) => {
      const was = c.from !== null && activeStates.has(c.from);
      const is = activeStates.has(c.to);
      if (!was && is) active++;
      if (was && !is) active--;
      maxActive = Math.max(maxActive, active);
    });

    const report = await s.fleet.run();

    expect(Object.values(report.states)).toEqual(['integrated', 'integrated', 'integrated', 'integrated', 'integrated']);
    expect(maxActive).toBe(2);
    expect(tracker.max).toBeLessThanOrEqual(2);
    expect(tracker.max).toBe(2); // hubo paralelismo real
    const order = s.changes.map((c) => `${c.taskId}:${c.to}`);
    const at = (label: string) => order.indexOf(label);
    expect(at('td:running')).toBeGreaterThan(at('ta:integrated'));
    expect(at('td:running')).toBeGreaterThan(at('tb:integrated'));
    expect(at('te:running')).toBeGreaterThan(at('td:integrated'));
    // Las difíciles fueron a Claude.
    for (const id of ['ta', 'tb']) expect(s.router.isClaude(report.tasks.find((t) => t.taskId === id)?.authors[0] ?? '')).toBe(true);
    s.expectNoLeases();
  });

  it('una tarea que llega a la cola mientras otra corre arranca enseguida si hay cupo', async () => {
    const work = (t: TaskBrief): Step[] => (isReview(t) ? verdictScript('aprobado') : t.id === 'larga' ? [{ wait: 400 }, ...okScript(t.id)] : okScript(t.id));
    const s = await setup({
      agents: [agents.claude1, agents.claude2, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      concurrency: 3,
      scripts: { 'claude-1': work, 'claude-2': work, codex: work },
    });
    s.queue.add(task('larga'));
    const added = delay(40).then(() => s.queue.add(task('nueva'))); // aprobada con la flota ya corriendo
    const report = await s.fleet.run();
    await added;
    expect(report.states).toEqual({ larga: 'integrated', nueva: 'integrated' });
    const order = s.changes.map((c) => `${c.taskId}:${c.to}`);
    // Sin despertador, «nueva» quedaba `ready` hasta que «larga» terminaba su ciclo completo.
    expect(order.indexOf('nueva:running')).toBeGreaterThan(-1);
    expect(order.indexOf('nueva:running')).toBeLessThan(order.indexOf('larga:review'));
    expect(order.indexOf('nueva:integrated')).toBeLessThan(order.indexOf('larga:integrated'));
    s.expectNoLeases();
  });

  it('cancelar una tarea en curso detiene al agente y cancela a sus dependientes', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      // Se cancela con el agente ya corriendo (un plazo fijo puede llegar antes de que arranque).
      scripts: { codex: [{ effect: () => { setTimeout(() => s.fleet.cancel('larga'), 30); } }, { untilAbort: true }, { error: 'cancelled' }, { done: false }] },
    });
    s.queue.addAll([task('larga'), task('despues', { dependsOn: ['larga'] })]);
    const report = await s.fleet.run();
    expect(report.states).toEqual({ larga: 'cancelled', despues: 'cancelled' });
    expect(s.adapter('codex').calls[0]?.ctx.signal.aborted).toBe(true);
    expect(s.workspaces.integrated).toEqual([]);
    s.expectNoLeases();
  });
});

describe('revisión: encargo y veredicto', () => {
  it('el encargo de revisión incluye criterios, rutas y diff, y su id es válido aunque la tarea tenga 64 caracteres', () => {
    const long = task('x'.repeat(64), { acceptance: ['npm test en verde'], ownedPaths: ['src/x/**'] });
    const review = buildReviewTask(long, ['codex', 'claude-1'], 'Archivos: src/x/a.ts');
    expect(review.id).toHaveLength(64);
    expect(review.id.endsWith('-revision')).toBe(true);
    expect(review.objective).toContain('npm test en verde');
    expect(review.objective).toContain('`src/x/**`');
    expect(review.objective).toContain('Archivos: src/x/a.ts');
    expect(review.objective).toContain('codex → claude-1');
  });

  it('lee el último veredicto JSON válido y valida su forma', () => {
    expect(parseReviewVerdict(['```\n{"veredicto":"rechazado","observaciones":["a"]}\n```'])).toEqual({ veredicto: 'rechazado', observaciones: ['a'] });
    expect(parseReviewVerdict(['{"veredicto":"aprobado"}', 'Al final: {"veredicto":"rechazado","observaciones":["b"]} gracias'])).toEqual({ veredicto: 'rechazado', observaciones: ['b'] });
    expect(parseReviewVerdict(['{"veredicto":"quizás"}'])).toBeUndefined();
    expect(parseReviewVerdict(['sin json'])).toBeUndefined();
  });

  it('las observaciones se agregan al objetivo sin perder el original', () => {
    const t = withFeedback(task('obs'), { source: 'integración', notes: ['Conflicto al integrar: src/a.ts'], round: 1 });
    expect(t.objective.startsWith('Implementar obs')).toBe(true);
    expect(t.objective).toContain('### Observaciones (integración, ronda 1)');
    expect(t.objective).toContain('- Conflicto al integrar: src/a.ts');
  });
});
