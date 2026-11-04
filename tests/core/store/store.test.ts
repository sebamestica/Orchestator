import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore, StoreError, type StoreOptions } from '../../../src/core/store/index.ts';
import { MIGRATIONS } from '../../../src/core/store/schema.ts';
import type { AgentConfig, AgentEvent, ProbeResult, TaskBrief } from '../../../src/shared/index.ts';
import { agyQuota, agyUsages, codexUsage, textEvent, usageEvent } from './fixture-events.ts';

const SECRET = 'sk-ant-' + 'x'.repeat(30);

let dir: string;
const open: SqliteStore[] = [];

function newStore(opts: Partial<StoreOptions> = {}): SqliteStore {
  const s = new SqliteStore({ path: ':memory:', timeZone: 'UTC', ...opts });
  open.push(s);
  return s;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-store-'));
});

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const agent: AgentConfig = {
  id: 'claude-1',
  kind: 'claude-sdk',
  provider: 'anthropic',
  displayName: 'Claude',
  secretRef: 'claude-1-key',
  quotaFloor: 0.2,
  enabled: true,
};

const probe: ProbeResult = {
  agentId: 'claude-1',
  installed: true,
  authenticated: true,
  models: ['claude-opus-5-5'],
  quotaMethod: 'manual-budget',
  warnings: [],
};

function brief(id: string, projectId = 'proj-a', extra: Partial<TaskBrief> = {}): TaskBrief {
  return {
    id,
    projectId,
    title: `Tarea ${id}`,
    objective: 'Hacer algo',
    ownedPaths: [`src/${id}/**`],
    dependsOn: [],
    acceptance: ['pruebas en verde'],
    difficulty: 'low',
    contextRefs: [],
    skillRefs: [],
    ...extra,
  };
}

const T0 = '2026-11-01T12:00:00.000Z';

describe('SqliteStore: esquema y archivo', () => {
  it('aplica todas las migraciones', () => {
    const s = newStore();
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it('persiste en un archivo y conserva los datos al reabrir sin volver a migrar', () => {
    const path = join(dir, 'sub', 'orquestador.db');
    const a = new SqliteStore({ path, timeZone: 'UTC' });
    a.putAgent({ config: agent, quotaMethod: 'manual-budget' });
    a.append(textEvent('s1', 'claude-1', 0, T0, 'hola'));
    a.close();
    expect(existsSync(path)).toBe(true);

    const b = newStore({ path });
    expect(b.schemaVersion()).toBe(MIGRATIONS.length);
    expect(b.getAgent('claude-1')?.quotaMethod).toBe('manual-budget');
    expect(b.eventsSince('s1')).toHaveLength(1);
  });
});

describe('SqliteStore: agentes', () => {
  it('crea, lee, lista, actualiza y borra', () => {
    const s = newStore({ now: () => new Date(T0) });
    const created = s.putAgent({ config: agent, quotaMethod: 'manual-budget', lastProbe: probe });
    expect(created.createdAt).toBe(T0);
    expect(s.listAgents().map((a) => a.config.id)).toEqual(['claude-1']);

    // Omitir quotaMethod/lastProbe conserva lo guardado; createdAt no cambia.
    const updated = s.putAgent({ config: { ...agent, displayName: 'Claude (principal)' } });
    expect(updated.config.displayName).toBe('Claude (principal)');
    expect(updated.quotaMethod).toBe('manual-budget');
    expect(updated.lastProbe).toEqual(probe);
    expect(s.getAgent('claude-1')?.createdAt).toBe(T0);

    // null explícito sí borra.
    const cleared = s.putAgent({ config: agent, quotaMethod: null, lastProbe: null });
    expect(cleared.quotaMethod).toBeNull();
    expect(s.getAgent('claude-1')?.lastProbe).toBeNull();

    expect(s.deleteAgent('claude-1')).toBe(true);
    expect(s.deleteAgent('claude-1')).toBe(false);
    expect(s.getAgent('claude-1')).toBeUndefined();
  });

  it('aplica los valores por defecto de AgentConfig y rechaza configuraciones inválidas', () => {
    const s = newStore();
    const rec = s.putAgent({ config: { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' } as AgentConfig });
    expect(rec.config.quotaFloor).toBe(0.2);
    expect(rec.config.enabled).toBe(true);
    expect(() => s.putAgent({ config: { ...agent, id: 'Mayúsculas' } })).toThrow();
  });

  it('tacha secretos que lleguen en la configuración o el probe', () => {
    const s = newStore();
    s.putAgent({ config: { ...agent, displayName: `clave ${SECRET}` }, lastProbe: { ...probe, warnings: [`falló con ${SECRET}`] } });
    const text = JSON.stringify(s.getAgent('claude-1'));
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTADO]');
  });
});

describe('SqliteStore: eventos', () => {
  it('tacha los secretos en la salida y en los bytes del archivo (.db y -wal)', () => {
    const path = join(dir, 'eventos.db');
    const s = newStore({ path });
    s.append(textEvent('s1', 'claude-1', 0, T0, `mi clave es ${SECRET}`));
    s.append({ sessionId: 's1', agentId: 'claude-1', seq: 1, ts: T0, type: 'tool_call', payload: { callId: 'c1', name: 'bash', inputSummary: `export KEY=${SECRET}` } });
    const out = JSON.stringify(s.eventsSince('s1'));
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTADO]');

    const files = [path, `${path}-wal`, `${path}-shm`].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f).includes(Buffer.from(SECRET))).toBe(false);
    s.close();
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false);
    expect(readFileSync(path).includes(Buffer.from('[REDACTADO]'))).toBe(true);
  });

  it('appendEvent devuelve el evento guardado y es idempotente por (sesión, seq)', () => {
    const s = newStore();
    const first = s.appendEvent(textEvent('s1', 'claude-1', 0, T0, 'hola'));
    expect(first).toMatchObject({ seq: 0, type: 'text' });
    expect(s.appendEvent(textEvent('s1', 'claude-1', 0, T0, 'otro texto'))).toBeUndefined();
    const events = s.eventsSince('s1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { text: 'hola' } });
    // La misma seq en otra sesión sí se guarda.
    expect(s.appendEvent(textEvent('s2', 'claude-1', 0, T0, 'hola'))).toBeDefined();
  });

  it('un usage duplicado no se suma dos veces', () => {
    const s = newStore();
    const e = usageEvent('s1', 'codex', 0, T0, codexUsage());
    s.append(e);
    s.append(e);
    expect(s.usageTotals()[0]?.entries).toBe(1);
  });

  it('rechaza eventos inválidos con StoreError invalid sin guardar nada', () => {
    const s = newStore();
    const bad = { sessionId: 's1', agentId: 'claude-1', seq: -1, ts: 'ayer', type: 'text', payload: { text: 'x', role: 'assistant' } } as unknown as AgentEvent;
    let err: unknown;
    try {
      s.append(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe('invalid');
    expect((err as StoreError).message).toMatch(/seq/);
    expect(s.eventsSince('s1')).toEqual([]);
    expect(s.getSession('s1')).toBeUndefined();
  });

  it('reconexión: eventsSince devuelve solo seq > since, en orden y con límite', () => {
    const s = newStore();
    for (const seq of [3, 0, 4, 1, 2]) s.append(textEvent('s1', 'claude-1', seq, T0, `t${seq}`));
    s.append(textEvent('otra', 'claude-1', 9, T0, 'no'));
    expect(s.eventsSince('s1').map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(s.eventsSince('s1', 1).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(s.eventsSince('s1', 1, 2).map((e) => e.seq)).toEqual([2, 3]);
    expect(s.eventsSince('s1', 4)).toEqual([]);
    expect(s.eventsSince('no-existe')).toEqual([]);
    expect(s.getSession('s1')?.lastSeq).toBe(4);

    // Un cliente que vio hasta lastSeq y reconecta recibe solo lo nuevo.
    const seen = s.getSession('s1')?.lastSeq ?? -1;
    s.append(textEvent('s1', 'claude-1', 5, T0, 't5'));
    expect(s.eventsSince('s1', seen).map((e) => e.seq)).toEqual([5]);
  });

  it('conserva parentSessionId y lo omite cuando no hay', () => {
    const s = newStore();
    s.append({ ...textEvent('sub-1', 'claude-1', 0, T0, 'subagente'), parentSessionId: 's1' });
    s.append(textEvent('s1', 'claude-1', 0, T0, 'padre'));
    expect(s.eventsSince('sub-1')[0]?.parentSessionId).toBe('s1');
    expect(s.eventsSince('s1')[0]).not.toHaveProperty('parentSessionId');
    expect(s.getSession('sub-1')?.parentSessionId).toBe('s1');
    expect(s.listSessions({ parentSessionId: 's1' }).map((x) => x.id)).toEqual(['sub-1']);
  });
});

describe('SqliteStore: sesiones', () => {
  it('sigue el estado: starting → running → waiting → done', () => {
    const s = newStore();
    s.putTask(brief('t-1'));
    const started = s.startSession({ id: 's1', agentId: 'claude-1', taskId: 't-1' });
    expect(started).toMatchObject({ state: 'starting', taskId: 't-1', lastSeq: -1, endedAt: null });

    s.append(textEvent('s1', 'claude-1', 0, '2026-11-01T12:00:01.000Z', 'trabajando'));
    expect(s.getSession('s1')?.state).toBe('running');

    s.append({ sessionId: 's1', agentId: 'claude-1', seq: 1, ts: '2026-11-01T12:00:02.000Z', type: 'status', payload: { state: 'waiting' } });
    expect(s.getSession('s1')?.state).toBe('waiting');

    s.append({ sessionId: 's1', agentId: 'claude-1', seq: 2, ts: '2026-11-01T12:00:03.000Z', type: 'done', payload: { ok: true } });
    const done = s.getSession('s1');
    expect(done).toMatchObject({ state: 'done', endedAt: '2026-11-01T12:00:03.000Z', lastSeq: 2, taskId: 't-1' });

    // Un evento tardío no reabre la sesión.
    s.append(textEvent('s1', 'claude-1', 3, '2026-11-01T12:00:04.000Z', 'tarde'));
    expect(s.getSession('s1')).toMatchObject({ state: 'done', lastSeq: 3 });
    expect(s.listSessions({ taskId: 't-1' }).map((x) => x.id)).toEqual(['s1']);
  });

  it('done con ok=false deja la sesión en failed', () => {
    const s = newStore();
    s.append({ sessionId: 's2', agentId: 'codex', seq: 0, ts: T0, type: 'status', payload: { state: 'running' } });
    s.append({ sessionId: 's2', agentId: 'codex', seq: 1, ts: T0, type: 'error', payload: { code: 'quota_exhausted', message: 'sin cupo' } });
    s.append({ sessionId: 's2', agentId: 'codex', seq: 2, ts: '2026-11-01T12:05:00.000Z', type: 'done', payload: { ok: false } });
    expect(s.getSession('s2')).toMatchObject({ state: 'failed', endedAt: '2026-11-01T12:05:00.000Z' });
  });

  it('una sesión creada por su primer evento queda en running', () => {
    const s = newStore();
    s.append(textEvent('s3', 'agy', 0, T0, 'hola'));
    expect(s.getSession('s3')).toMatchObject({ state: 'running', agentId: 'agy', taskId: null, startedAt: T0 });
    // startSession después del primer evento enlaza la tarea sin perder el estado.
    s.startSession({ id: 's3', agentId: 'agy', taskId: 't-9' });
    expect(s.getSession('s3')).toMatchObject({ state: 'running', taskId: 't-9', lastSeq: 0 });
    expect(s.listSessions({ agentId: 'agy' })).toHaveLength(1);
    expect(s.listSessions({ agentId: 'codex' })).toHaveLength(0);
  });
});

describe('SqliteStore: uso', () => {
  const codex = codexUsage();
  const agy = agyUsages();

  it('los fixtures reales traen uso', () => {
    expect(codex).toMatchObject({ inputTokens: 22572, cachedInputTokens: 13440, outputTokens: 5, reasoningTokens: 0 });
    expect(agy).toHaveLength(1);
    expect(agy[0]).toMatchObject({ inputTokens: 7354, outputTokens: 34, reasoningTokens: 33, cachedInputTokens: 0 });
  });

  function seed(s: SqliteStore): void {
    // Codex: dos turnos en la sesión cx-1 (día 1) y uno en cx-2 (día 2).
    s.append(usageEvent('cx-1', 'codex', 0, '2026-11-01T10:00:00.000Z', codex));
    s.append(usageEvent('cx-1', 'codex', 1, '2026-11-01T11:00:00.000Z', codex));
    s.append(usageEvent('cx-2', 'codex', 0, '2026-11-02T10:00:00.000Z', codex));
    // agy: un paso real en ag-1 (día 1).
    for (const [i, u] of agy.entries()) s.append(usageEvent('ag-1', 'agy', i, '2026-11-01T15:00:00.000Z', u));
    // Claude con costo y dos modelos.
    s.append(usageEvent('cl-1', 'claude-1', 0, '2026-11-01T09:00:00.000Z', { inputTokens: 100, outputTokens: 50, costUsd: 0.25, model: 'claude-opus-5-5' }));
    s.append(usageEvent('cl-1', 'claude-1', 1, '2026-11-02T09:00:00.000Z', { inputTokens: 10, outputTokens: 5, costUsd: 0.5, model: 'claude-haiku' }));
    // Los eventos que no son usage no cuentan.
    s.append(textEvent('cl-1', 'claude-1', 2, '2026-11-02T09:00:01.000Z', 'listo'));
  }

  it('total general sin agrupar', () => {
    const s = newStore();
    expect(s.usageTotals()).toEqual([]);
    seed(s);
    const [total] = s.usageTotals();
    expect(total).toEqual({
      inputTokens: 3 * 22572 + 7354 + 110,
      outputTokens: 3 * 5 + 34 + 55,
      cachedInputTokens: 3 * 13440,
      reasoningTokens: 33,
      costUsd: 0.75,
      entries: 6,
    });
  });

  it('agrupa por agente, día, sesión y modelo', () => {
    const s = newStore();
    seed(s);
    const byAgent = s.usageTotals({ groupBy: ['agent'] });
    expect(byAgent.map((r) => [r.agentId, r.inputTokens, r.entries])).toEqual([
      ['agy', 7354, 1],
      ['claude-1', 110, 2],
      ['codex', 3 * 22572, 3],
    ]);
    expect(byAgent.find((r) => r.agentId === 'agy')).toMatchObject({ reasoningTokens: 33, costUsd: 0 });

    const byDay = s.usageTotals({ groupBy: ['day'] });
    expect(byDay.map((r) => [r.day, r.entries])).toEqual([
      ['2026-11-01', 4],
      ['2026-11-02', 2],
    ]);

    const bySession = s.usageTotals({ groupBy: ['session'] });
    expect(bySession.map((r) => [r.sessionId, r.outputTokens])).toEqual([
      ['ag-1', 34],
      ['cl-1', 55],
      ['cx-1', 10],
      ['cx-2', 5],
    ]);

    const byModel = s.usageTotals({ groupBy: ['model'], agentId: 'claude-1' });
    expect(byModel.map((r) => [r.model, r.costUsd])).toEqual([
      ['claude-haiku', 0.5],
      ['claude-opus-5-5', 0.25],
    ]);
  });

  it('combina agrupaciones y filtros (agente, sesión, modelo, desde/hasta)', () => {
    const s = newStore();
    seed(s);
    const agentDay = s.usageTotals({ groupBy: ['agent', 'day'], agentId: 'codex' });
    expect(agentDay.map((r) => [r.agentId, r.day, r.inputTokens])).toEqual([
      ['codex', '2026-11-01', 2 * 22572],
      ['codex', '2026-11-02', 22572],
    ]);
    // groupBy repetido no duplica columnas.
    expect(s.usageTotals({ groupBy: ['agent', 'agent'], agentId: 'agy' })).toHaveLength(1);

    expect(s.usageTotals({ sessionId: 'cx-1' })[0]?.entries).toBe(2);
    expect(s.usageTotals({ model: 'claude-haiku' })[0]?.costUsd).toBe(0.5);
    expect(s.usageTotals({ from: '2026-11-02' })[0]?.entries).toBe(2);
    expect(s.usageTotals({ to: '2026-11-01' })[0]?.entries).toBe(4);
    expect(s.usageTotals({ from: '2026-11-02', to: '2026-11-02', groupBy: ['agent'] }).map((r) => r.agentId)).toEqual(['claude-1', 'codex']);
    expect(s.usageTotals({ agentId: 'nadie' })).toEqual([]);
    expect(() => s.usageTotals({ from: '01/11/2026' })).toThrow();
  });

  it('spentUsd suma el costo del agente, opcionalmente desde un día', () => {
    const s = newStore();
    expect(s.spentUsd('claude-1')).toBe(0);
    seed(s);
    expect(s.spentUsd('claude-1')).toBeCloseTo(0.75);
    expect(s.spentUsd('claude-1', '2026-11-02')).toBeCloseTo(0.5);
    expect(s.spentUsd('codex')).toBe(0);
  });

  it('el día depende de la zona horaria del almacén (borde de medianoche)', () => {
    // 02:30 UTC del 2 de noviembre = 23:30 del 1 de noviembre en Chile (UTC−3 en horario de verano).
    const ts = '2026-11-02T02:30:00.000Z';
    const utc = newStore({ timeZone: 'UTC' });
    const scl = newStore({ timeZone: 'America/Santiago' });
    for (const s of [utc, scl]) s.append(usageEvent('s1', 'codex', 0, ts, codex));
    expect(utc.dayOf(ts)).toBe('2026-11-02');
    expect(scl.dayOf(ts)).toBe('2026-11-01');
    expect(utc.usageTotals({ groupBy: ['day'] })[0]?.day).toBe('2026-11-02');
    expect(scl.usageTotals({ groupBy: ['day'] })[0]?.day).toBe('2026-11-01');
    expect(scl.usageTotals({ from: '2026-11-02' })).toEqual([]);
  });
});

describe('SqliteStore: cupos', () => {
  it('guarda fotos y devuelve la última por agente y el historial', () => {
    let clock = Date.parse(T0);
    const s = newStore({ now: () => new Date(clock) });
    const first = agyQuota('agy', '2026-11-01T12:00:00.000Z');
    expect(first.buckets.length).toBe(4);
    s.recordQuota(first);
    clock += 60_000;
    const second = { ...agyQuota('agy', '2026-11-01T12:05:00.000Z'), stale: true };
    s.recordQuota(second);
    clock += 60_000;
    s.recordQuota({ agentId: 'codex', method: 'codex-ratelimits', takenAt: T0, stale: false, buckets: [], error: `fallo con ${SECRET}` });

    const latest = s.latestQuotas();
    expect(latest.map((q) => q.snapshot.agentId)).toEqual(['agy', 'codex']);
    expect(latest[0]?.snapshot).toEqual(second);
    expect(latest[0]?.recordedAt).toBe(new Date(Date.parse(T0) + 60_000).toISOString());
    expect(latest[1]?.snapshot.error).not.toContain(SECRET);

    const history = s.quotaHistory('agy');
    expect(history.map((q) => q.snapshot.takenAt)).toEqual(['2026-11-01T12:05:00.000Z', '2026-11-01T12:00:00.000Z']);
    expect(s.quotaHistory('agy', 1)).toHaveLength(1);
    expect(s.quotaHistory('nadie')).toEqual([]);
  });

  it('rechaza fotos inválidas', () => {
    const s = newStore();
    expect(() => s.recordQuota({ ...agyQuota('agy', T0), takenAt: 'ahora' })).toThrow();
    expect(s.latestQuotas()).toEqual([]);
  });
});

describe('SqliteStore: proyectos, planes y tareas', () => {
  it('CRUD de proyectos', () => {
    const s = newStore({ now: () => new Date(T0) });
    const p = s.putProject({ id: 'proj-a', name: 'Proyecto A', repoPath: 'C:\\dev\\a' });
    expect(p.createdAt).toBe(T0);
    s.putProject({ id: 'proj-a', name: 'Proyecto A2', repoPath: 'C:\\dev\\a2' });
    s.putProject({ id: 'proj-b', name: 'B', repoPath: 'C:\\dev\\b' });
    expect(s.getProject('proj-a')).toEqual({ id: 'proj-a', name: 'Proyecto A2', repoPath: 'C:\\dev\\a2', createdAt: T0 });
    expect(s.listProjects().map((x) => x.id)).toEqual(['proj-a', 'proj-b']);
    expect(s.deleteProject('proj-b')).toBe(true);
    expect(s.deleteProject('proj-b')).toBe(false);
    expect(() => s.putProject({ id: 'X', name: '', repoPath: '' })).toThrow();
  });

  it('createPlan guarda el plan y sus tareas en pending, tachando secretos', () => {
    const s = newStore();
    const plan = s.createPlan({
      id: 'plan-1',
      projectId: 'proj-a',
      text: `Plan con clave ${SECRET}`,
      warnings: ['ojo'],
      tasks: [brief('t-a'), brief('t-b', 'proj-a', { dependsOn: ['t-a'], objective: `usar ${SECRET}` })],
    });
    expect(plan.taskIds).toEqual(['t-a', 't-b']);
    expect(plan.text).not.toContain(SECRET);
    const loaded = s.getPlan('plan-1');
    expect(loaded).toMatchObject({ id: 'plan-1', projectId: 'proj-a', warnings: ['ojo'], taskIds: ['t-a', 't-b'] });
    expect(loaded?.text).toContain('[REDACTADO]');
    const tb = s.getTask('t-b');
    expect(tb).toMatchObject({ state: 'pending', planId: 'plan-1', agentId: null });
    expect(tb?.task.objective).not.toContain(SECRET);
    expect(s.listTasks({ planId: 'plan-1' })).toHaveLength(2);
    expect(s.getPlan('no-existe')).toBeUndefined();
  });

  it('createPlan: conflicto con ids existentes, proyecto distinto y repetidos, sin dejar nada a medias', () => {
    const s = newStore();
    s.putTask(brief('t-b'));
    const expectCode = (fn: () => unknown, code: string) => {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe(code);
    };
    expectCode(() => s.createPlan({ id: 'plan-1', projectId: 'proj-a', text: 'x', tasks: [brief('t-a'), brief('t-b')] }), 'conflict');
    expect(s.getPlan('plan-1')).toBeUndefined();
    expect(s.getTask('t-a')).toBeUndefined();

    expectCode(() => s.createPlan({ id: 'plan-2', projectId: 'proj-a', text: 'x', tasks: [brief('t-c', 'proj-z')] }), 'invalid');
    expectCode(() => s.createPlan({ id: 'plan-3', projectId: 'proj-a', text: 'x', tasks: [brief('t-d'), brief('t-d')] }), 'invalid');
    expect(s.getTask('t-c')).toBeUndefined();
    expect(s.getTask('t-d')).toBeUndefined();

    s.createPlan({ id: 'plan-4', projectId: 'proj-a', text: 'x', tasks: [brief('t-e')] });
    expectCode(() => s.createPlan({ id: 'plan-4', projectId: 'proj-a', text: 'x', tasks: [brief('t-f')] }), 'conflict');
    expect(s.getTask('t-f')).toBeUndefined();
    expect(s.listTasks().map((t) => t.task.id)).toEqual(['t-b', 't-e']);
  });

  it('putTask, filtros de listTasks y setTaskState', () => {
    let clock = Date.parse(T0);
    const s = newStore({ now: () => new Date((clock += 1000)) });
    s.putTask(brief('t-1', 'proj-a'));
    s.putTask(brief('t-2', 'proj-b'), 'ready');
    s.putTask(brief('t-3', 'proj-a'), 'running');
    expect(s.listTasks().map((t) => t.task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(s.listTasks({ projectId: 'proj-a' }).map((t) => t.task.id)).toEqual(['t-1', 't-3']);
    expect(s.listTasks({ state: 'ready' }).map((t) => t.task.id)).toEqual(['t-2']);
    expect(s.listTasks({ projectId: 'proj-a', state: 'running' }).map((t) => t.task.id)).toEqual(['t-3']);

    const before = s.getTask('t-1');
    const moved = s.setTaskState('t-1', 'running', 'codex');
    expect(moved).toMatchObject({ state: 'running', agentId: 'codex' });
    expect(moved.updatedAt > (before?.updatedAt ?? '')).toBe(true);
    expect(moved.createdAt).toBe(before?.createdAt);
    // Sin agentId conserva el asignado.
    expect(s.setTaskState('t-1', 'review').agentId).toBe('codex');
    expect(s.setTaskState('t-1', 'integrated', null).agentId).toBeNull();

    // putTask sobre una existente reemplaza el encargo.
    const replaced = s.putTask(brief('t-1', 'proj-a', { title: 'Nuevo título' }), 'pending');
    expect(replaced).toMatchObject({ state: 'pending', task: { title: 'Nuevo título' } });

    let err: unknown;
    try {
      s.setTaskState('no-existe', 'ready');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe('not_found');
    expect(() => s.setTaskState('t-1', 'inventado' as never)).toThrow();
  });
});
