import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translateAgyEvent } from '../../../src/core/adapters/agy-cli/translate.ts';
import { translateCodexEvent } from '../../../src/core/adapters/codex-cli/translate.ts';
import { ROUTE_MODULE_FACTORIES } from '../../../src/core/app/route-modules.ts';
import { usageRouteModule } from '../../../src/core/app/f5-uso.ts';
import { CONDUCTOR_AGENT_ID } from '../../../src/core/conductor/index.ts';
import { DEFAULT_MIND_AGENT_ID, normalizeTokens, resolveRange } from '../../../src/core/usage-stats/index.ts';
import { usageRatesResponse, usageSummaryResponse, type AgentEvent, type UsageBucket, type UsageSummary } from '../../../src/shared/index.ts';
import { agyQuota } from '../store/fixture-events.ts';
import { claudeRunUsage, makeUsageApp, seedAgents, seedChat, sumUsage, task, usage } from './helpers.ts';

type App = ReturnType<typeof makeUsageApp>;

const lines = (rel: string) =>
  readFileSync(new URL(`../../../fixtures/${rel}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim());

function bodiesToEvents(bodies: { type: string; payload: unknown }[], sessionId: string, agentId: string, ts: string): AgentEvent[] {
  return bodies.filter((b) => b.type === 'usage').map((b, i) => ({ sessionId, agentId, seq: 100 + i, ts, type: 'usage', payload: b.payload }) as AgentEvent);
}

/**
 * Escenario (días en Santiago; «hoy» es 2026-11-04):
 * - tarea-a (berland): autor Claude (salida real del SDK, con caché escrita) y revisor Codex (salida real de exec);
 * - tarea-b (vetworld): autor agy (stream real, 3 pasos);
 * - chat de la mente sobre vetworld; planificador; sesiones sueltas (registros anteriores al issue 5).
 */
function seed(app: App): void {
  const { store } = app;
  seedAgents(store);
  store.putProject({ id: 'berland', name: 'Berland', repoPath: 'C:\\dev\\orquestador' });
  store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: 'C:\\dev\\vetworld' });
  store.putTask(task('tarea-a', 'berland'), 'review');
  store.setTaskState('tarea-a', 'review', 'claude');
  store.putTask(task('tarea-b', 'vetworld'), 'running');
  store.setTaskState('tarea-b', 'running', 'agy');

  store.startSession({ id: 'ses-autor', agentId: 'claude', taskId: 'tarea-a' });
  for (const e of claudeRunUsage('ses-autor', '2026-11-04T15:00:00.000Z')) store.append(e);

  store.startSession({ id: 'ses-revisor', agentId: 'codex', taskId: 'tarea-a' });
  const codex = lines('codex/exec-ok.jsonl').flatMap((l) => translateCodexEvent(JSON.parse(l), l));
  for (const e of bodiesToEvents(codex, 'ses-revisor', 'codex', '2026-11-04T16:00:00.000Z')) store.append(e);

  store.startSession({ id: 'ses-agy', agentId: 'agy', taskId: 'tarea-b' });
  const agy = lines('agy/stream-edit-command.jsonl').flatMap((l) => translateAgyEvent(JSON.parse(l), l));
  for (const e of bodiesToEvents(agy, 'ses-agy', 'agy', '2026-11-03T12:00:00.000Z')) store.append(e);

  seedChat(store, 'chat-mente-1', 'vetworld');
  store.append(usage('chat-mente-1', 'orquestador', '2026-11-02T10:00:00.000Z', { inputTokens: 100_000, cachedInputTokens: 80_000, cacheWriteTokens: 15_000, outputTokens: 2_000, costUsd: 0.5, model: 'claude-opus-5-5' }));
  // Anteriores al issue 5 (sin cacheWriteTokens).
  store.append(usage('plan-0716189a', 'claude', '2026-11-01T12:00:00.000Z', { inputTokens: 3_000, cachedInputTokens: 0, outputTokens: 500, costUsd: 0.02, model: 'claude-sonnet-5-5' }));
  store.append(usage('suelta-1', 'claude', '2026-10-30T12:00:00.000Z', { inputTokens: 5_000, cachedInputTokens: 4_000, outputTokens: 100, costUsd: 0.01, model: 'claude-opus-5-5' }));
  store.append(usage('suelta-2', 'claude', '2026-11-05T00:30:00.000Z', { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.004, model: 'claude-opus-5-5' }));
  store.append(usage('suelta-3', 'claude', '2026-10-15T12:00:00.000Z', { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 20, costUsd: 0.008, model: 'claude-opus-5-5' }));
  // Fila real de agy del 2026-11-04, guardada antes de normalizar: la entrada sin la caché.
  store.append(usage('agy-viejo', 'agy', '2026-11-04T12:00:00.000Z', { inputTokens: 6_699, cachedInputTokens: 16_741, outputTokens: 660, reasoningTokens: 605 }));
  store.recordQuota(agyQuota('agy', '2026-11-04T20:00:00.000Z'));
}

async function summary(app: App, query = ''): Promise<UsageSummary> {
  const res = await app.req('GET', `/usage/summary${query}`);
  expect(res.status, res.text).toBe(200);
  return usageSummaryResponse.parse(res.json);
}

const fields = ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'entries'] as const;
function sumBuckets(buckets: readonly UsageBucket[]): Record<(typeof fields)[number] | 'costUsd' | 'costWithRateUsd', number> {
  const out = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, entries: 0, costUsd: 0, costWithRateUsd: 0 };
  for (const b of buckets) for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] += b[k];
  return out;
}
function expectSameBucket(actual: ReturnType<typeof sumBuckets>, expected: UsageBucket): void {
  for (const k of fields) expect(actual[k], k).toBe(expected[k]);
  expect(actual.costUsd).toBeCloseTo(expected.costUsd, 6);
  expect(actual.costWithRateUsd).toBeCloseTo(expected.costWithRateUsd, 6);
}

let app: App;
beforeEach(() => {
  app = makeUsageApp();
  seed(app);
});
afterEach(() => app.close());

describe('GET /usage/summary: cuadra con la tabla usage (criterio 1)', () => {
  it('el mes: totales, por modelo, día, rol y proyecto suman lo mismo que usage del periodo', async () => {
    const s = await summary(app, '?period=month');
    expect(s).toMatchObject({ currency: 'USD', timeZone: 'America/Santiago', today: '2026-11-04', period: 'month', from: '2026-11-01', to: '2026-11-04' });
    const inMonth = "day BETWEEN '2026-11-01' AND '2026-11-04'";
    const api = `${inMonth} AND agent_id NOT IN ('codex', 'agy')`;
    const sub = `${inMonth} AND agent_id IN ('codex', 'agy')`;

    // Registros y costo, contra la tabla.
    expect(s.totals.api.entries + s.totals.subscription.entries).toBe(sumUsage(app.store, '1', inMonth));
    expect(s.totals.api.costUsd).toBeCloseTo(sumUsage(app.store, 'cost_usd', inMonth), 6);
    expect(s.totals.api.outputTokens).toBe(sumUsage(app.store, 'output_tokens', api));
    expect(s.totals.subscription.outputTokens).toBe(sumUsage(app.store, 'output_tokens', sub));
    expect(s.totals.api.cacheReadTokens).toBe(sumUsage(app.store, 'cached_input_tokens', api));
    // En la API la entrada registrada es la total: nueva + escrita + leída.
    expect(s.totals.api.inputTokens + s.totals.api.cacheWriteTokens + s.totals.api.cacheReadTokens).toBe(sumUsage(app.store, 'input_tokens', api));
    // agy viejo guardaba la entrada sin la caché: la suscripción cuadra con entrada + leída de la fila vieja.
    expect(s.totals.subscription.inputTokens + s.totals.subscription.cacheReadTokens).toBe(sumUsage(app.store, 'input_tokens', sub) + 16_741);

    // Cada desglose suma los totales.
    for (const billing of ['api', 'subscription'] as const) {
      expectSameBucket(sumBuckets(s.byModel.filter((m) => m.billing === billing)), s.totals[billing]);
      expectSameBucket(sumBuckets(s.byDay.map((d) => d[billing])), s.totals[billing]);
      expectSameBucket(sumBuckets(s.byRole.map((r) => r[billing])), s.totals[billing]);
      expectSameBucket(sumBuckets(s.byProject.map((p) => p[billing])), s.totals[billing]);
    }
    expect(s.byDay.map((d) => d.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    // total = nueva + escrita + leída + salida.
    const t = s.totals.api;
    expect(t.totalTokens).toBe(t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens + t.outputTokens);
  });

  it('por modelo: la caché escrita de la salida real del SDK va aparte y la entrada nueva es la que queda', async () => {
    const s = await summary(app, '?period=today');
    const opus = s.byModel.find((m) => m.billing === 'api' && m.model === 'claude-opus-5-5');
    // subagent-run.jsonl: 16 nuevos + 46 330 leídos + 77 719 escritos; más la fila suelta de las 21:30 (anterior).
    expect(opus).toMatchObject({ inputTokens: 16 + 1_000, cacheWriteTokens: 77_719, cacheReadTokens: 46_330, outputTokens: 196 + 10, entries: 2, multiplier: 1, agentIds: ['claude'] });
    expect(opus?.costUsd).toBeCloseTo(0.401845 + 0.004, 6);
    // La carga del evento guarda la caché escrita (la tabla usage no tiene columna para ella).
    const raw = app.store.database.prepare("SELECT e.payload_json FROM usage u JOIN events e ON e.id = u.event_id WHERE u.session_id = 'ses-autor'").get();
    expect(JSON.parse(String(raw?.payload_json))).toMatchObject({ cacheWriteTokens: 77_719 });
  });

  it('un rango con from/to (octubre) también cuadra y trae un día por fecha', async () => {
    const s = await summary(app, '?from=2026-10-01&to=2026-10-31');
    expect(s).toMatchObject({ period: null, from: '2026-10-01', to: '2026-10-31' });
    expect(s.byDay).toHaveLength(31);
    expect(s.totals.api.entries).toBe(sumUsage(app.store, '1', "day BETWEEN '2026-10-01' AND '2026-10-31'"));
    expect(s.totals.api.costUsd).toBeCloseTo(0.01 + 0.008, 6);
    // Los periodos fijos siguen siendo los de hoy.
    expect(s.periods.month.from).toBe('2026-11-01');
    expect(s.periods.month.api.entries).toBe((await summary(app, '?period=month')).totals.api.entries);
  });
});

// Los costos salen redondeados a 1 µUSD: las comparaciones con 1,3 × admiten esa diferencia (5 decimales).
describe('tarifa (criterio 2)', () => {
  it('con 1,3 en un modelo, «con tu tarifa» = 1,3 × «estimado» en ese modelo y el resto queda igual', async () => {
    const res = await app.req('PATCH', '/usage/rates', { rates: { 'claude-opus-5-5': 1.3 } });
    expect(res.status, res.text).toBe(200);
    expect(usageRatesResponse.parse(res.json).rates).toEqual([{ model: 'claude-opus-5-5', multiplier: 1.3, updatedAt: '2026-11-05T01:00:00.000Z' }]);
    const s = await summary(app, '?period=month');
    const opus = s.byModel.find((m) => m.model === 'claude-opus-5-5');
    const sonnet = s.byModel.find((m) => m.model === 'claude-sonnet-5-5');
    expect(opus?.multiplier).toBe(1.3);
    expect(opus?.costWithRateUsd).toBeCloseTo(1.3 * (opus?.costUsd ?? 0), 5);
    expect(sonnet).toMatchObject({ multiplier: 1, costUsd: 0.02, costWithRateUsd: 0.02 });
    expect(s.totals.api.costWithRateUsd).toBeCloseTo(1.3 * (opus?.costUsd ?? 0) + 0.02, 5);
    expect(s.periods.month.api.costWithRateUsd).toBeCloseTo(s.totals.api.costWithRateUsd, 6);
  });

  it('con 1,3 en todos los modelos de la API, el total con tu tarifa es 1,3 × el estimado (también lo ya registrado)', async () => {
    await app.req('PATCH', '/usage/rates', { rates: { 'claude-opus-5-5': 1.3, 'claude-sonnet-5-5': 1.3 } });
    const s = await summary(app, '?from=2026-10-01&to=2026-11-04');
    expect(s.totals.api.costWithRateUsd).toBeCloseTo(1.3 * s.totals.api.costUsd, 5);
    for (const p of ['today', 'week', 'month'] as const) expect(s.periods[p].api.costWithRateUsd).toBeCloseTo(1.3 * s.periods[p].api.costUsd, 5);
    for (const d of s.byDay) expect(d.api.costWithRateUsd).toBeCloseTo(1.3 * d.api.costUsd, 5);
  });

  it('GET /usage/rates; null vuelve a 1; 1 no se guarda; multiplicadores y modelos inválidos dan 400', async () => {
    expect((await app.req('GET', '/usage/rates')).json).toEqual({ rates: [] });
    await app.req('PATCH', '/usage/rates', { rates: { 'claude-opus-5-5': 1.3, 'claude-sonnet-5-5': 1.25 } });
    const res = await app.req('PATCH', '/usage/rates', { rates: { 'claude-opus-5-5': null, 'claude-sonnet-5-5': 1 } });
    expect(res.json).toEqual({ rates: [] });
    for (const rates of [{ 'claude-opus-5-5': 0 }, { 'claude-opus-5-5': 11 }, { 'claude-opus-5-5': -1 }, {}, { '   ': 1.2 }, { [`sk-ant-api03-${'a'.repeat(40)}`]: 1.2 }]) {
      const bad = await app.req('PATCH', '/usage/rates', { rates });
      expect(bad.status, JSON.stringify(rates)).toBe(400);
      expect(bad.text).not.toContain('sk-ant-api03');
    }
    expect((await app.req('GET', '/usage/rates')).json).toEqual({ rates: [] });
  });
});

describe('suscripción aparte (criterio 3) y caché normalizada (criterio 4)', () => {
  it('Codex y agy van como suscripción: tokens, cupo y costo 0, con el modelo de agy', async () => {
    const s = await summary(app, '?period=month');
    expect(s.totals.subscription.costUsd).toBe(0);
    expect(s.totals.subscription.costWithRateUsd).toBe(0);
    const subModels = s.byModel.filter((m) => m.billing === 'subscription');
    expect(subModels.every((m) => m.costUsd === 0 && m.costWithRateUsd === 0 && m.multiplier === 1)).toBe(true);
    expect(subModels.map((m) => [m.model, m.agentIds, m.entries])).toEqual([
      [null, ['agy', 'codex'], 2],
      ['gemini-3.8-flash-low', ['agy'], 3],
    ]);
    expect(s.byModel.filter((m) => m.billing === 'api').every((m) => !m.agentIds.includes('codex') && !m.agentIds.includes('agy'))).toBe(true);

    const [agy, codex] = s.subscriptions;
    expect(s.subscriptions.map((r) => r.agentId)).toEqual(['agy', 'codex']);
    expect(agy).toMatchObject({ displayName: 'Antigravity (agy)', kind: 'agy-cli', models: ['gemini-3.8-flash-low'], quotaTakenAt: '2026-11-04T20:00:00.000Z', quotaStale: false, costUsd: 0 });
    expect(agy?.quotaRemaining).toBeGreaterThanOrEqual(0);
    expect(codex).toMatchObject({ kind: 'codex-cli', models: [], quotaRemaining: null, quotaTakenAt: null, entries: 1, inputTokens: 22_572 - 13_440, cacheReadTokens: 13_440 });
  });

  it('agy: la fila vieja (entrada sin caché) y la normalizada dan la misma entrada nueva', async () => {
    app.store.append(usage('agy-nuevo', 'agy', '2026-11-04T13:00:00.000Z', { inputTokens: 6_699 + 16_741, cachedInputTokens: 16_741, cacheWriteTokens: 0, outputTokens: 660, reasoningTokens: 605 }));
    const s = await summary(app, '?period=today');
    const sinModelo = s.byModel.find((m) => m.billing === 'subscription' && m.model === null);
    // codex (22 572 con 13 440 de caché) + las dos filas de agy (6 699 nuevos y 16 741 leídos cada una).
    expect(sinModelo).toMatchObject({ entries: 3, inputTokens: 22_572 - 13_440 + 2 * 6_699, cacheReadTokens: 13_440 + 2 * 16_741 });
  });

  it('cuenta los registros de API anteriores al issue 5 (sin caché escrita) y los sin tarea', async () => {
    const s = await summary(app, '?period=month');
    // planificador y suelta-2 (de API, sin cacheWriteTokens); otros = suelta-2 y la fila vieja de agy.
    expect(s.coverage).toEqual({ withoutCacheWrite: 2, withoutCost: 0, unlinked: 2 });
  });
});

describe('rol y proyecto', () => {
  it('mente, autor, revisor (otro agente en la misma tarea), planificador y otros; proyecto de la tarea o del chat', async () => {
    const s = await summary(app, '?period=month');
    const roles = Object.fromEntries(s.byRole.map((r) => [r.role, [r.api.entries, r.subscription.entries]]));
    expect(roles).toEqual({ mind: [1, 0], author: [1, 3], reviewer: [0, 1], planner: [1, 0], other: [1, 1] });
    expect(s.byRole.map((r) => r.role)).toEqual(['mind', 'author', 'reviewer', 'planner', 'other']);
    const mind = s.byRole.find((r) => r.role === 'mind');
    expect(mind?.api).toMatchObject({ inputTokens: 5_000, cacheWriteTokens: 15_000, cacheReadTokens: 80_000, costUsd: 0.5 });

    const projects = Object.fromEntries(s.byProject.map((p) => [String(p.projectId), [p.name, p.api.entries, p.subscription.entries]]));
    expect(projects).toEqual({ berland: ['Berland', 1, 1], vetworld: ['Vetworld', 1, 3], null: [null, 2, 1] });
    // Sin proyecto va al final; el resto, por gasto.
    expect(s.byProject.at(-1)?.projectId).toBeNull();
  });
});

describe('periodos y zona horaria', () => {
  it('hoy, 7 días y el mes calendario relativos a hoy en Santiago', async () => {
    const s = await summary(app);
    expect(s.period).toBe('month');
    expect(s.periods.today).toMatchObject({ from: '2026-11-04', to: '2026-11-04' });
    expect(s.periods.week).toMatchObject({ from: '2026-10-29', to: '2026-11-04' });
    expect(s.periods.month).toMatchObject({ from: '2026-11-01', to: '2026-11-04' });
    expect([s.periods.today.api.entries, s.periods.week.api.entries, s.periods.month.api.entries]).toEqual([2, 5, 4]);
    expect([s.periods.today.subscription.entries, s.periods.week.subscription.entries]).toEqual([2, 5]);
    expect(s.periods.week.api.costUsd).toBeCloseTo(0.401845 + 0.004 + 0.5 + 0.02 + 0.01, 6);
  });

  it('con tz=UTC el registro de las 00:30 UTC pasa al 5 de noviembre (que es hoy en UTC)', async () => {
    const santiago = await summary(app, '?period=today');
    expect(santiago.byModel.find((m) => m.model === 'claude-opus-5-5')?.entries).toBe(2);
    const utc = await summary(app, '?period=today&tz=UTC');
    expect(utc).toMatchObject({ today: '2026-11-05', timeZone: 'UTC', from: '2026-11-05', to: '2026-11-05' });
    expect(utc.totals.api).toMatchObject({ entries: 1, inputTokens: 1_000, costUsd: 0.004 });
  });

  it('consultas inválidas: zona desconocida, fechas al revés o inexistentes, rango largo, period con from', async () => {
    for (const q of ['?tz=Marte/Olimpo', '?from=2026-11-04&to=2026-11-01', '?from=2026-02-30&to=2026-03-01', '?from=2025-01-01&to=2026-11-04', '?period=week&from=2026-11-01', '?period=anual', '?from=4-11-2026']) {
      const res = await app.req('GET', `/usage/summary${q}`);
      expect(res.status, q).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });

  it('resolveRange: from solo llega hasta hoy; to solo es un día', () => {
    expect(resolveRange({ from: '2026-11-02' }, '2026-11-04')).toEqual({ from: '2026-11-02', to: '2026-11-04', period: null });
    expect(resolveRange({ to: '2026-10-15' }, '2026-11-04')).toEqual({ from: '2026-10-15', to: '2026-10-15', period: null });
    expect(resolveRange({ period: 'week' }, '2026-11-04')).toEqual({ from: '2026-10-29', to: '2026-11-04', period: 'week' });
    expect(resolveRange({ period: 'month' }, '2026-03-01')).toEqual({ from: '2026-03-01', to: '2026-03-01', period: 'month' });
  });
});

describe('normalizeTokens', () => {
  it('normalizado: la escrita se acota a lo que cabe (un acumulado colado no deja la entrada negativa)', () => {
    expect(normalizeTokens({ input: 1_000, cached: 600, cacheWrite: 900, output: 5, reasoning: 0 }, 'claude-sdk').tokens).toEqual({ input: 0, cacheWrite: 400, cacheRead: 600, output: 5, reasoning: 0 });
  });
  it('anterior: Claude y Codex con la leída dentro; agy (o leída mayor que la entrada) sin ella', () => {
    expect(normalizeTokens({ input: 5_000, cached: 4_000, cacheWrite: null, output: 1, reasoning: 0 }, 'claude-sdk')).toEqual({ tokens: { input: 1_000, cacheWrite: 0, cacheRead: 4_000, output: 1, reasoning: 0 }, legacy: true });
    expect(normalizeTokens({ input: 6_699, cached: 16_741, cacheWrite: null, output: 660, reasoning: 605 }, 'agy-cli').tokens.input).toBe(6_699);
    expect(normalizeTokens({ input: 6_699, cached: 16_741, cacheWrite: null, output: 660, reasoning: 605 }, undefined).tokens.input).toBe(6_699);
    expect(normalizeTokens({ input: 3_000, cached: 1_000, cacheWrite: null, output: 0, reasoning: 0 }, 'agy-cli').tokens.input).toBe(3_000);
  });
});

describe('cableado', () => {
  it('la línea de c29-uso está en ROUTE_MODULE_FACTORIES y la mente es CONDUCTOR_AGENT_ID', () => {
    expect(ROUTE_MODULE_FACTORIES).toContain(usageRouteModule);
    expect(DEFAULT_MIND_AGENT_ID).toBe(CONDUCTOR_AGENT_ID);
  });

  it('sin datos ni tabla de chats responde vacío y con los días del rango', async () => {
    const empty = makeUsageApp();
    try {
      const res = await empty.req('GET', '/usage/summary?period=week');
      expect(res.status).toBe(200);
      const s = usageSummaryResponse.parse(res.json);
      expect(s.byDay).toHaveLength(7);
      expect([s.byModel, s.byRole, s.byProject, s.subscriptions]).toEqual([[], [], [], []]);
      expect(s.totals.api).toMatchObject({ entries: 0, costUsd: 0, totalTokens: 0 });
    } finally {
      empty.close();
    }
  });
});
