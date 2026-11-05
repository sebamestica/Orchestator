import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNote } from '../../../src/core/memory/frontmatter.ts';
import { ObsidianMemory } from '../../../src/core/memory/obsidian-memory.ts';
import { Fleet, type FleetOptions } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue, type TaskStateChange } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import { parseTaskPlan, planFromStore, type PlanMemory } from '../../../src/core/orchestrator/task-plan.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import type { AgentConfig, MemoryStore, QuotaProvider, RunContext, TaskBrief } from '../../../src/shared/index.ts';
import { agents, FakeMemory, FakeQuota, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task, verdictScript, type Script } from './fakes.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const isReview = (t: TaskBrief) => t.id.endsWith('-revision');
const PLAN_ID = 'plan-20261104-a1b2c3';

async function writeTaskPlan(ctx: RunContext, text: string): Promise<void> {
  await mkdir(join(ctx.worktreePath, '.orq'), { recursive: true });
  await writeFile(join(ctx.worktreePath, '.orq', 'PLAN-TAREA.md'), text, 'utf8');
}
const readPlanFile = (ctx: RunContext) => readFile(join(ctx.worktreePath, '.orq', 'PLAN.md'), 'utf8');

/** Almacén real con un plan de dos tareas (como `POST /plans`). */
function storeWithPlan(): SqliteStore {
  const store = new SqliteStore({ path: ':memory:' });
  cleanups.push(async () => store.close());
  store.putProject({ id: 'demo', name: 'Demo', repoPath: 'C:\\dev\\demo' });
  store.createPlan({
    id: PLAN_ID,
    projectId: 'demo',
    text: 'Plan: primero el parser y sus pruebas; después la documentación.',
    tasks: [task('parser', { suggestedAgent: 'codex' }), task('docs', { ownedPaths: ['docs/**'], dependsOn: ['parser'] })],
  });
  return store;
}

async function setup(opts: {
  agents: AgentConfig[];
  scripts: Record<string, Script | Script[]>;
  quotas?: QuotaProvider[];
  memory?: MemoryStore;
  fleet?: Partial<FleetOptions>;
}) {
  const workspaces = await FakeWorkspaces.create();
  cleanups.push(() => workspaces.dispose());
  const queue = new TaskQueue();
  const changes: TaskStateChange[] = [];
  queue.on((c) => changes.push(c));
  const router = new Router({ agents: opts.agents, quotas: opts.quotas });
  const adapters = new Map(opts.agents.map((a) => [a.id, new ScriptedAdapter(a, opts.scripts[a.id] ?? [])]));
  const supervisor = new Supervisor({ adapters: adapters.values(), router, sink: new MemorySink(), queue, graceMs: 30 });
  const memory = opts.memory ?? new FakeMemory();
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
    ...opts.fleet,
  });
  const adapter = (id: string): ScriptedAdapter => {
    const a = adapters.get(id);
    if (!a) throw new Error(`sin adaptador ${id}`);
    return a;
  };
  const reviewDetail = (taskId: string) => changes.filter((c) => c.taskId === taskId && c.to === 'review').map((c) => c.detail ?? '');
  return { workspaces, queue, changes, router, memory, writes, warnings, fleet, adapter, reviewDetail };
}

describe('plan obligatorio: .orq/PLAN.md y traspaso', () => {
  it('escribe el plan del almacén antes de cada intento y el traspaso por cupo lleva los pasos pendientes', async () => {
    const store = storeWithPlan();
    const seen: string[] = [];
    const s = await setup({
      agents: [agents.claude1, agents.codex, agents.agy],
      quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.9)],
      fleet: { planFor: planFromStore(store) },
      scripts: {
        codex: [
          { effect: async (ctx) => { seen.push(await readPlanFile(ctx)); } },
          { effect: (ctx) => writeTaskPlan(ctx, '# Plan de parser\n- [x] 1. Parser\n- [ ] 2. Pruebas del parser\n- [ ] 3. Documentar el formato\n\n## Riesgos\n- ninguno') },
          { file: 'src/parser/index.ts', change: 'add' },
          { error: 'quota_exhausted', message: 'usage limit' },
          { done: false },
        ],
        'claude-1': [
          { effect: async (ctx) => { seen.push(await readPlanFile(ctx)); } },
          { effect: (ctx) => writeTaskPlan(ctx, '# Plan de parser\n- [x] 1. Parser\n- [x] 2. Pruebas del parser\n- [x] 3. Documentar el formato') },
          ...okScript('pruebas y documentación', 'tests/parser/index.test.ts'),
        ],
        agy: verdictScript('aprobado'),
      },
    });
    s.queue.add(task('parser', { suggestedAgent: 'codex' }));

    const report = await s.fleet.run();
    const r = report.tasks[0];
    expect(r).toMatchObject({ state: 'integrated', authors: ['codex', 'claude-1'], reviewers: ['agy'] });

    // .orq/PLAN.md antes de cada intento (autor, traspaso y revisión), siempre junto a .orq/BRIEF.md.
    const ws = s.workspaces.created[0]?.path ?? '';
    const plan = join(ws, '.orq', 'PLAN.md');
    const brief = join(ws, '.orq', 'BRIEF.md');
    expect(s.writes.map((w) => w.path)).toEqual([plan, brief, plan, brief, plan, brief]);
    // El agente lo encuentra ya escrito al arrancar: texto del plan y tareas hermanas.
    expect(seen).toHaveLength(2);
    for (const text of seen) {
      expect(text).toContain(`# Plan general ${PLAN_ID}`);
      expect(text).toContain('Plan: primero el parser y sus pruebas; después la documentación.');
      expect(text).toContain('- `parser` — Tarea parser **(tu tarea)** · rutas: `src/parser/**` · depende de: ninguna');
      expect(text).toContain('- `docs` — Tarea docs · rutas: `docs/**` · depende de: `parser`');
    }

    // El traspaso (Supervisor, por cupo) lleva los pasos pendientes: en el adaptador, en el brief y en el informe.
    const pending = ['Plan de la tarea (`.orq/PLAN-TAREA.md`): 1 hechos, 2 pendientes.', '- [ ] 2. Pruebas del parser', '- [ ] 3. Documentar el formato'];
    const summary = s.adapter('claude-1').calls[0]?.ctx.handoff?.partialSummary ?? '';
    for (const line of pending) expect(summary).toContain(line);
    expect(summary).not.toContain('- [ ] 1. Parser');
    const secondBrief = s.writes[3]?.content ?? '';
    expect(secondBrief).toContain('Lee `.orq/PLAN-TAREA.md` del agente anterior y sigue desde el primer paso sin marcar');
    for (const line of pending) expect(secondBrief).toContain(line);
    expect(r?.handoffs[0]?.partialSummary).toContain(pending[0]);
    expect(summary.split(pending[0] ?? '').length).toBe(2); // una sola vez

    // Pasos contados en el informe, en el evento de la cola y en cada sesión de memoria.
    expect(r?.plan).toEqual({ id: PLAN_ID, source: 'plan', exists: true, done: 3, pending: 0 });
    expect(r?.warnings).toEqual([]);
    expect(s.reviewDetail('parser')).toEqual(['ronda 1 · plan: 3/3 pasos hechos']);
    const sessions = (s.memory as FakeMemory).sessions as (FakeMemory['sessions'][number] & { plan?: unknown })[];
    expect(sessions.map((x) => [x.agentId, x.outcome, x.plan])).toEqual([
      ['codex', 'handed_off', { exists: true, done: 1, pending: 2 }],
      ['claude-1', 'ok', { exists: true, done: 3, pending: 0 }],
    ]);

    // El revisor recibe el plan de la tarea para compararlo con el trabajo.
    const reviewTask = s.adapter('agy').calls[0]?.task;
    expect(reviewTask?.objective).toContain('### Plan de la tarea (`.orq/PLAN-TAREA.md` del autor)\n# Plan de parser\n- [x] 1. Parser');
    expect(reviewTask?.objective).toContain('Compara el trabajo con el plan de la tarea');
    expect(s.writes[5]?.content).toContain('## Plan de la tarea revisada');
    expect(s.writes[5]?.content).not.toContain('Plan de implementación (obligatorio)');
    // La revisión no pisa el plan de la tarea.
    expect(parseTaskPlan(await readFile(join(ws, '.orq', 'PLAN-TAREA.md'), 'utf8'))).toMatchObject({ done: 3, pending: 0 });
  });

  it('el traspaso de la flota tras dos fallos de integración también lleva los pendientes', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.claude2, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: {
        codex: [{ effect: (ctx) => writeTaskPlan(ctx, '1. [x] Gate\n2. [ ] Arreglar la prueba de fechas') }, ...okScript('hecho', 'src/gate/a.ts')],
        'claude-1': (t) => (isReview(t) ? verdictScript('aprobado') : okScript('corregido')),
        'claude-2': (t) => (isReview(t) ? verdictScript('aprobado') : okScript('corregido')),
      },
    });
    const gateFail = { ok: false, conflicts: [], gateSummary: 'npm run gate: 1 prueba fallida' };
    s.workspaces.integrationScript.set('gate', [gateFail, gateFail]);
    s.queue.add(task('gate'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('integrated');
    const handoff = r?.handoffs.find((h) => h.reason === 'failure');
    expect(handoff?.partialSummary).toContain('Observaciones (integración): Verificación del proyecto: npm run gate: 1 prueba fallida');
    expect(handoff?.partialSummary).toContain('Plan de la tarea (`.orq/PLAN-TAREA.md`): 1 hechos, 1 pendientes.');
    expect(handoff?.partialSummary).toContain('- [ ] Arreglar la prueba de fechas');
    const claudeCall = [...s.adapter('claude-1').calls, ...s.adapter('claude-2').calls].find((c) => !isReview(c.task));
    expect(claudeCall?.ctx.handoff?.partialSummary).toBe(handoff?.partialSummary);
  });
});

describe('plan obligatorio: comprobación de .orq/PLAN-TAREA.md', () => {
  it('tarea suelta: plan mínimo (sin repetir el encargo); sin PLAN-TAREA.md avisa y la tarea se integra igual', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: { codex: okScript('hecho', 'src/api/a.ts'), 'claude-1': verdictScript('aprobado') },
    });
    s.queue.add(task('api', { dependsOn: [], acceptance: ['npm test en verde', 'sin solapes'] }));
    const r = (await s.fleet.run()).tasks[0];

    expect(r?.state).toBe('integrated');
    const planText = s.writes[0]?.content ?? '';
    expect(s.writes[0]?.path.endsWith(join('.orq', 'PLAN.md'))).toBe(true);
    expect(planText).toContain('# Plan de la tarea suelta api');
    // El objetivo, las rutas y los criterios ya van en el encargo: el plan mínimo del worktree no los repite.
    expect(planText).not.toContain('## Objetivo');
    expect(planText).not.toContain('## Criterios de aceptación');
    expect(planText).toContain('## Dependencias\nNinguna.');

    const warning = 'api: codex no escribió `.orq/PLAN-TAREA.md` (aviso: la tarea sigue).';
    expect(r?.warnings).toEqual([warning]);
    expect(s.warnings).toContain(warning);
    expect(r?.plan).toEqual({ id: 'api', source: 'tarea', exists: false, done: 0, pending: 0 });
    expect(s.reviewDetail('api')).toEqual(['ronda 1 · aviso: el autor no escribió `.orq/PLAN-TAREA.md`']);
    expect(s.adapter('claude-1').calls[0]?.task.objective).toContain('(el autor no escribió `.orq/PLAN-TAREA.md`)');
    expect((s.memory as FakeMemory).sessions[0]).toMatchObject({ agentId: 'codex', plan: { exists: false, done: 0, pending: 0 } });
  });

  it('un PLAN-TAREA.md sin casillas también avisa; un fallo definitivo conserva el aviso en el informe', async () => {
    const fail = [{ effect: (ctx: RunContext) => writeTaskPlan(ctx, 'Voy a hacerlo todo de una vez.') }, { error: 'crash' as const }, { done: false }];
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      fleet: {},
      scripts: { codex: fail, 'claude-1': fail },
    });
    s.queue.add(task('rota'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('failed');
    expect(r?.detail).toMatch(/sin éxito tras/);
    expect(r?.warnings.length).toBeGreaterThan(0);
    for (const w of r?.warnings ?? []) expect(w).toMatch(/^rota: (codex|claude-1) dejó `\.orq\/PLAN-TAREA\.md` sin pasos `- \[ \]`/);
    expect(r?.plan).toMatchObject({ exists: true, done: 0, pending: 0 });
  });

  it('el revisor recibe el plan de la tarea recortado a 4000 caracteres', async () => {
    const long = ['# Plan', ...Array.from({ length: 400 }, (_, k) => `- [ ] ${k + 1}. Paso con bastante texto para ocupar espacio`)].join('\n');
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      scripts: { codex: [{ effect: (ctx) => writeTaskPlan(ctx, long) }, ...okScript('hecho')], 'claude-1': verdictScript('aprobado') },
    });
    s.queue.add(task('larga'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.plan).toMatchObject({ exists: true, done: 0, pending: 400 });
    const objective = s.adapter('claude-1').calls[0]?.task.objective ?? '';
    const section = objective.slice(objective.indexOf('### Plan de la tarea'), objective.indexOf('### Resumen del diff'));
    expect(section).toContain('- [ ] 1. Paso con bastante texto');
    expect(section).not.toContain('- [ ] 400.');
    expect(section.length).toBeLessThanOrEqual(4_000 + 80);
  });

  it('si planFor falla: aviso y plan mínimo, sin hacer fallar la tarea', async () => {
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      fleet: { planFor: () => { throw new Error('almacén cerrado'); } },
      scripts: { codex: okScript('hecho'), 'claude-1': verdictScript('aprobado') },
    });
    s.queue.add(task('suelta'));
    const r = (await s.fleet.run()).tasks[0];
    expect(r?.state).toBe('integrated');
    expect(s.warnings.join('\n')).toContain('suelta: sin plan general (almacén cerrado); se usa el plan mínimo del encargo.');
    expect(s.writes[0]?.content).toContain('# Plan de la tarea suelta suelta');
  });
});

describe('plan obligatorio: memoria', () => {
  it('con ObsidianMemory real: el plan queda en Proyectos/<p>/Planes/, las sesiones lo enlazan y buildContext no lo incluye', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'orq-plan-boveda-'));
    cleanups.push(() => rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const memory = new ObsidianMemory({ vaultPath: vault });
    const asPort: PlanMemory = memory; // ObsidianMemory cumple el puerto de la flota
    expect(typeof asPort.recordPlan).toBe('function');
    const store = storeWithPlan();
    const s = await setup({
      agents: [agents.claude1, agents.codex],
      quotas: [new FakeQuota('codex', 0.9)],
      memory,
      fleet: { planFor: planFromStore(store) },
      scripts: {
        codex: [{ effect: (ctx) => writeTaskPlan(ctx, '- [x] 1. Parser\n- [ ] 2. Pruebas') }, ...okScript('parser hecho', 'src/parser/index.ts')],
        'claude-1': verdictScript('aprobado'),
      },
    });
    s.queue.add(task('parser', { suggestedAgent: 'codex' }));
    const r = (await s.fleet.run()).tasks[0];
    const note = `Orquestador/Proyectos/demo/Planes/${PLAN_ID}`;
    expect(r).toMatchObject({ state: 'integrated', plan: { id: PLAN_ID, source: 'plan', note, exists: true, done: 1, pending: 1 } });

    const planNote = parseNote(await readFile(join(vault, `${note}.md`), 'utf8'));
    expect(planNote.data).toMatchObject({ tipo: 'plan', proyecto: 'demo', plan: PLAN_ID, tareas: ['parser', 'docs'] });
    expect(planNote.body).toContain('Plan: primero el parser y sus pruebas; después la documentación.');
    expect(planNote.body).not.toContain('tu tarea');

    const sessionFile = (await memory.listSessions('demo'))[0]?.notePath ?? '';
    const session = parseNote(await readFile(join(vault, sessionFile), 'utf8'));
    expect(session.data).toMatchObject({ tipo: 'sesion', plan: PLAN_ID, plan_tarea: true, plan_pasos_hechos: 1, plan_pasos_pendientes: 1 });
    expect(session.body).toContain(`- Plan: [[${note}|${PLAN_ID}]] · Pasos de \`.orq/PLAN-TAREA.md\`: 1 hechos, 1 pendientes`);

    // El contexto de memoria del siguiente encargo no trae el plan (ya va en .orq/PLAN.md).
    const context = await memory.buildContext('demo', task('docs', { ownedPaths: ['docs/**'], title: 'Tarea parser docs' }), 4_000);
    expect(context).toContain('parser');
    expect(context).not.toContain('primero el parser y sus pruebas');
    expect(context).not.toContain('Planes/');
  });

  it('planMemory: null desactiva la nota del plan aunque la memoria sepa guardarla', async () => {
    const recorded: string[] = [];
    const memory = Object.assign(new FakeMemory(), { recordPlan: async (input: { planId: string }) => { recorded.push(input.planId); return `nota/${input.planId}`; } });
    const off = await setup({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.9)], memory, fleet: { planMemory: null }, scripts: { codex: okScript('hecho'), 'claude-1': verdictScript('aprobado') } });
    off.queue.add(task('sin-nota'));
    expect((await off.fleet.run()).tasks[0]?.plan?.note).toBeUndefined();
    expect(recorded).toEqual([]);
    const on = await setup({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.9)], memory, scripts: { codex: okScript('hecho'), 'claude-1': verdictScript('aprobado') } });
    on.queue.add(task('con-nota'));
    expect((await on.fleet.run()).tasks[0]?.plan?.note).toBe('nota/con-nota');
    expect(recorded).toEqual(['con-nota']);
  });
});
