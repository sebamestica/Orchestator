import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/shared/index.ts';
import { fakeKey, makeTestApp } from './helpers.ts';

type Json = Record<string, unknown>;
const ts = (s: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, s)).toISOString();

function textEvent(sessionId: string, seq: number, text: string, agentId = 'codex'): AgentEvent {
  return { sessionId, agentId, seq, ts: ts(seq), type: 'text', payload: { text, role: 'assistant' } };
}

async function seedProject(t: ReturnType<typeof makeTestApp>, id = 'proyecto-1') {
  const res = await t.req('POST', '/projects', { body: { id, name: 'Proyecto', repoPath: `C:\\dev\\${id}` } });
  expect(res.status).toBe(201);
  return res.json;
}

describe('rutas: sistema y agentes', () => {
  it('GET /health', async () => {
    const t = makeTestApp();
    const res = await t.req('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, version: '0.1.0' });
  });

  it('alta por clave, lista, detalle, cambio, probe y borrado', async () => {
    const t = makeTestApp();
    const created = await t.req('POST', '/agents', {
      body: { provider: 'anthropic', apiKey: t.validKey, displayName: 'Claude', baseUrl: 'https://api.example.com', budgetUsd: 20 },
    });
    expect(created.status).toBe(201);
    const agent = created.json.agent as { config: Json };
    expect(agent.config).toMatchObject({ id: 'claude', kind: 'claude-sdk', provider: 'anthropic', budgetUsd: 20 });
    expect(Object.keys(agent.config)).not.toContain('apiKey');
    expect(created.text).not.toContain(t.validKey);
    expect(t.adapterLog.probes[0]?.apiKey).toBe(t.validKey);

    expect(((await t.req('GET', '/agents')).json.agents as unknown[]).length).toBe(1);
    expect((await t.req('GET', '/agents/claude')).status).toBe(200);
    expect((await t.req('GET', '/agents/otro')).status).toBe(404);

    const patched = await t.req('PATCH', '/agents/claude', { body: { enabled: false, budgetUsd: null } });
    expect(patched.status).toBe(200);
    expect((patched.json.agent as { config: Json }).config).not.toHaveProperty('budgetUsd');

    const probed = await t.req('POST', '/agents/claude/probe');
    expect(probed.status).toBe(200);
    expect((probed.json.probe as Json).quotaMethod).toBe('manual-budget');

    expect((await t.req('POST', '/agents', { body: { provider: 'anthropic', apiKey: t.validKey, displayName: 'Claude', id: 'claude' } })).status).toBe(409);
    expect((await t.req('DELETE', '/agents/claude')).json).toEqual({ deleted: true, id: 'claude' });
    expect(await t.vault.list()).toEqual([]);
    expect((await t.req('DELETE', '/agents/claude')).status).toBe(404);
  });

  it('una clave rechazada responde 422 probe_failed y no deja nada guardado', async () => {
    const t = makeTestApp();
    const bad = fakeKey();
    const res = await t.req('POST', '/agents', { body: { provider: 'openai', apiKey: bad, displayName: 'GPT' } });
    expect(res.status).toBe(422);
    expect((res.json.error as Json).code).toBe('probe_failed');
    expect(res.text).not.toContain(bad);
    expect((await t.req('GET', '/agents')).json.agents).toEqual([]);
    expect(await t.vault.list()).toEqual([]);
  });

  it('alta sin clave (CLI), detección de CLIs y 501 sin fábrica de adaptadores', async () => {
    const t = makeTestApp({
      detectors: [{ name: 'agy', detect: async () => ({ id: 'agy', kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity (agy)', executable: 'agy.exe', argsPrefix: [], version: '1.4.12' }) }],
    });
    const cli = await t.req('POST', '/agents', { body: { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex CLI' } });
    expect(cli.status).toBe(201);
    expect(cli.json.probe).toBeNull();
    expect((await t.req('POST', '/agents', { body: { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Otra vez' } })).status).toBe(409);
    expect((await t.req('POST', '/agents', { body: { id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Sin clave' } })).status).toBe(400);
    const detect = await t.req('POST', '/agents/detect');
    expect(detect.status).toBe(200);
    expect((detect.json.added as { config: Json }[]).map((a) => a.config.id)).toEqual(['agy']);

    const bare = makeTestApp({ withServices: false });
    await bare.req('POST', '/agents', { body: { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex CLI' } });
    expect((await bare.req('POST', '/agents/codex/probe')).status).toBe(501);
    expect((await bare.req('POST', '/agents', { body: { provider: 'openai', apiKey: fakeKey('sk-'), displayName: 'x' } })).status).toBe(501);
  });
});

describe('rutas: cupos', () => {
  it('refresh lee, guarda y lista; filtro por agente; errores tachados', async () => {
    const t = makeTestApp();
    await t.req('POST', '/agents', { body: { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' } });
    await t.req('POST', '/agents', { body: { id: 'roto', kind: 'agy-cli', provider: 'antigravity', displayName: 'Roto' } });
    const r = await t.req('POST', '/quotas/refresh', { body: {} });
    expect(r.status).toBe(200);
    expect((r.json.quotas as { snapshot: Json }[]).map((q) => q.snapshot.agentId)).toEqual(['codex']);
    expect((r.json.errors as Json[])[0]).toMatchObject({ agentId: 'roto' });
    const one = await t.req('POST', '/quotas/refresh', { body: { agentId: 'codex' } });
    expect((one.json.quotas as unknown[]).length).toBe(1);
    expect((await t.req('POST', '/quotas/refresh', { body: { agentId: 'nadie' } })).status).toBe(404);
    const list = await t.req('GET', '/quotas');
    expect((list.json.quotas as unknown[]).length).toBe(1);
    expect(((await t.req('GET', '/quotas?agentId=roto')).json.quotas as unknown[]).length).toBe(0);
    expect((await makeTestApp({ withServices: false }).req('POST', '/quotas/refresh')).status).toBe(501);
  });
});

describe('rutas: proyectos, planes y tareas', () => {
  it('proyectos: alta, conflicto, lista, detalle y borrado', async () => {
    const t = makeTestApp();
    await seedProject(t);
    expect((await t.req('POST', '/projects', { body: { id: 'proyecto-1', name: 'X', repoPath: 'C:\\x' } })).status).toBe(409);
    expect(((await t.req('GET', '/projects')).json.projects as unknown[]).length).toBe(1);
    expect((await t.req('GET', '/projects/proyecto-1')).json.project).toMatchObject({ name: 'Proyecto' });
    expect((await t.req('DELETE', '/projects/proyecto-1')).status).toBe(200);
    expect((await t.req('GET', '/projects/proyecto-1')).status).toBe(404);
  });

  it('plan → tareas pendientes → aprobar el plan (llama a la orquestación)', async () => {
    const t = makeTestApp();
    expect((await t.req('POST', '/plans', { body: { projectId: 'proyecto-1', text: 'Hacer A y B' } })).status).toBe(404);
    await seedProject(t);
    const res = await t.req('POST', '/plans', { body: { projectId: 'proyecto-1', text: 'Hacer A y B' } });
    expect(res.status).toBe(201);
    const plan = res.json.plan as { id: string; taskIds: string[] };
    expect(plan.id).toMatch(/^plan-\d{8}-[0-9a-f]{6}$/);
    expect((res.json.tasks as { state: string }[]).map((x) => x.state)).toEqual(['pending', 'pending']);
    expect(t.planner.calls[0]).toMatchObject({ projectId: 'proyecto-1', knownTaskIds: [] });

    await t.req('POST', '/plans', { body: { projectId: 'proyecto-1', text: 'Más' } });
    expect(t.planner.calls[1]?.knownTaskIds).toEqual(plan.taskIds);

    expect((await t.req('GET', `/plans/${plan.id}`)).json.plan).toMatchObject({ id: plan.id });
    const approved = await t.req('POST', `/plans/${plan.id}/approve`);
    expect((approved.json.tasks as { state: string }[]).map((x) => x.state)).toEqual(['ready', 'ready']);
    expect(t.hookCalls.approved).toEqual(plan.taskIds);
    expect((await t.req('GET', '/plans/plan-no-existe')).status).toBe(404);
  });

  it('plan que el planificador no logra validar → 422 con issues', async () => {
    const t = makeTestApp();
    await seedProject(t);
    const res = await t.req('POST', '/plans', { body: { projectId: 'proyecto-1', text: 'CICLO' } });
    expect(res.status).toBe(422);
    expect(res.json.error).toMatchObject({ code: 'plan_invalid', issues: [{ code: 'cycle', taskIds: ['a', 'b'] }] });
    expect((await makeTestApp({ withServices: false }).req('POST', '/plans', { body: { projectId: 'proyecto-1', text: 'x' } })).status).toBe(501);
  });

  it('tarea suelta: crear, filtrar, aprobar con agente, cancelar y transiciones inválidas', async () => {
    const t = makeTestApp();
    const brief = {
      id: 'tarea-1',
      projectId: 'proyecto-1',
      title: 'T',
      objective: 'O',
      ownedPaths: ['src/**'],
      dependsOn: [],
      acceptance: ['ok'],
      difficulty: 'medium',
    };
    expect((await t.req('POST', '/tasks', { body: brief })).status).toBe(404);
    await seedProject(t);
    expect((await t.req('POST', '/tasks', { body: brief })).status).toBe(201);
    expect((await t.req('POST', '/tasks', { body: brief })).status).toBe(409);
    expect(((await t.req('GET', '/tasks?projectId=proyecto-1&state=pending')).json.tasks as unknown[]).length).toBe(1);
    expect(((await t.req('GET', '/tasks?state=ready')).json.tasks as unknown[]).length).toBe(0);
    expect((await t.req('POST', '/tasks/tarea-1/approve', { body: { agentId: 'nadie' } })).status).toBe(404);
    await t.req('POST', '/agents', { body: { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' } });
    const ok = await t.req('POST', '/tasks/tarea-1/approve', { body: { agentId: 'codex' } });
    expect(ok.json.task).toMatchObject({ state: 'ready', agentId: 'codex' });
    expect((await t.req('POST', '/tasks/tarea-1/approve')).status).toBe(409);
    const cancelled = await t.req('POST', '/tasks/tarea-1/cancel', { body: { reason: 'cambio de plan' } });
    expect(cancelled.json.task).toMatchObject({ state: 'cancelled' });
    expect(t.hookCalls).toEqual({ approved: ['tarea-1'], cancelled: ['tarea-1'] });
    expect((await t.req('POST', '/tasks/tarea-1/cancel')).status).toBe(409);
    expect((await t.req('GET', '/tasks/no-existe')).status).toBe(404);
  });
});

describe('rutas: sesiones, eventos (reconexión por seq) y uso', () => {
  it('eventos desde un seq, paginados con lastSeq/hasMore', async () => {
    const t = makeTestApp();
    for (let seq = 0; seq < 7; seq++) t.hub.append(textEvent('ses-1', seq, `línea ${seq}`));
    t.hub.append(textEvent('ses-1', 3, 'reenvío duplicado'));
    const all = await t.req('GET', '/sessions/ses-1/events');
    expect((all.json.events as AgentEvent[]).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(all.json).toMatchObject({ lastSeq: 6, hasMore: false });

    const page1 = await t.req('GET', '/sessions/ses-1/events?since=2&limit=2');
    expect((page1.json.events as AgentEvent[]).map((e) => e.seq)).toEqual([3, 4]);
    expect(page1.json).toMatchObject({ lastSeq: 4, hasMore: true });
    const page2 = await t.req('GET', `/sessions/ses-1/events?since=${String(page1.json.lastSeq)}&limit=2`);
    expect((page2.json.events as AgentEvent[]).map((e) => e.seq)).toEqual([5, 6]);
    expect(page2.json).toMatchObject({ lastSeq: 6, hasMore: false });
    const none = await t.req('GET', '/sessions/ses-1/events?since=6');
    expect(none.json).toMatchObject({ events: [], lastSeq: 6, hasMore: false });
    expect((none.json.events as AgentEvent[]).find((e) => e.type === 'text' && e.payload.text.includes('duplicado'))).toBeUndefined();

    expect((await t.req('GET', '/sessions/ses-x/events')).status).toBe(404);
    expect((await t.req('GET', '/sessions/ses-1')).json.session).toMatchObject({ id: 'ses-1', lastSeq: 6, state: 'running' });
    expect(((await t.req('GET', '/sessions?agentId=codex')).json.sessions as unknown[]).length).toBe(1);
    expect((await t.req('GET', '/sessions/ses-x')).status).toBe(404);
  });

  it('uso por agente, día, sesión y modelo', async () => {
    const t = makeTestApp();
    const usage = (sessionId: string, seq: number, agentId: string, model: string, input: number, output: number, costUsd?: number): AgentEvent => ({
      sessionId,
      agentId,
      seq,
      ts: ts(seq),
      type: 'usage',
      payload: { inputTokens: input, outputTokens: output, model, ...(costUsd !== undefined ? { costUsd } : {}) },
    });
    t.hub.append(usage('s-a', 0, 'claude', 'opus', 100, 10, 0.5));
    t.hub.append(usage('s-a', 1, 'claude', 'haiku', 50, 5, 0.01));
    t.hub.append(usage('s-b', 0, 'codex', 'gpt', 22572, 5));
    const byAgent = await t.req('GET', '/usage?groupBy=agent');
    expect(byAgent.json.rows).toEqual([
      { agentId: 'claude', inputTokens: 150, outputTokens: 15, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.51, entries: 2 },
      { agentId: 'codex', inputTokens: 22572, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0, entries: 1 },
    ]);
    const byModel = await t.req('GET', '/usage?groupBy=session,model&agentId=claude');
    expect((byModel.json.rows as Json[]).map((r) => [r.sessionId, r.model, r.inputTokens])).toEqual([
      ['s-a', 'haiku', 50],
      ['s-a', 'opus', 100],
    ]);
    const byDay = await t.req('GET', '/usage?groupBy=day,agent,agent&from=2026-11-01&to=2026-11-01');
    expect(byDay.json.groupBy).toEqual(['day', 'agent']);
    expect((byDay.json.rows as Json[]).map((r) => r.day)).toEqual(['2026-11-01', '2026-11-01']);
    const total = await t.req('GET', '/usage');
    expect((total.json.rows as Json[])[0]).toMatchObject({ inputTokens: 22722, entries: 3 });
  });
});

describe('rutas: skills, memoria y WebSocket en proceso', () => {
  it('skills: lista, importar, aprobar, rechazar y errores del hub', async () => {
    const t = makeTestApp();
    expect(((await t.req('GET', '/skills')).json.skills as unknown[]).length).toBe(1);
    const imp = await t.req('POST', '/skills/import', { body: { source: 'C:\\descargas\\nueva.zip' } });
    expect(imp.status).toBe(201);
    expect(imp.json.result).toMatchObject({ name: 'nueva' });
    expect((await t.req('POST', '/skills/import', { body: { source: 'C:\\no-existe.zip' } })).status).toBe(404);
    expect((await t.req('POST', '/skills/nueva-1/approve')).json.result).toEqual({ name: 'nueva-1', approved: true });
    expect((await t.req('POST', '/skills/nueva-2/reject')).json.result).toEqual({ name: 'nueva-2', rejected: true });
    expect((await makeTestApp({ withServices: false }).req('GET', '/skills')).status).toBe(501);
  });

  it('skills: GET /skills/quarantine lista lo que espera revisión (501 sin hub)', async () => {
    const res = await makeTestApp().req('GET', '/skills/quarantine');
    expect(res.status).toBe(200);
    expect(res.json.skills).toEqual([{ id: 'nueva-20261104-105000-abc123', name: 'nueva', fileCount: 1 }]);
    expect((await makeTestApp({ withServices: false }).req('GET', '/skills/quarantine')).status).toBe(501);
  });

  it('memoria: contexto del proyecto o de una tarea, con presupuesto', async () => {
    const t = makeTestApp();
    expect((await t.req('GET', '/memory/proyecto-1/context')).status).toBe(404);
    await seedProject(t);
    const ctx = await t.req('GET', '/memory/proyecto-1/context?budget=500');
    expect(ctx.json).toMatchObject({ projectId: 'proyecto-1', taskId: null, budgetChars: 500 });
    expect(t.memory.calls[0]).toEqual({ projectId: 'proyecto-1', taskId: 'contexto-proyecto', budget: 500 });
    await seedProject(t, 'otro-proyecto');
    await t.req('POST', '/tasks', {
      body: { id: 'tarea-1', projectId: 'otro-proyecto', title: 'T', objective: 'O', ownedPaths: ['a'], dependsOn: [], acceptance: ['ok'], difficulty: 'low' },
    });
    expect((await t.req('GET', '/memory/proyecto-1/context?taskId=tarea-1')).status).toBe(404);
    const byTask = await t.req('GET', '/memory/otro-proyecto/context?taskId=tarea-1');
    expect(byTask.json).toMatchObject({ taskId: 'tarea-1', budgetChars: 4000 });
    expect(byTask.json.chars).toBe((byTask.json.context as string).length);
    expect((await makeTestApp({ withServices: false }).req('GET', '/memory/proyecto-1/context')).status).toBe(501);
  });

  it('/ws sin Upgrade → 426; en proceso (sin servidor HTTP) → 501', async () => {
    const t = makeTestApp();
    expect((await t.req('GET', '/ws')).status).toBe(426);
    expect((await t.req('GET', '/ws', { headers: { upgrade: 'websocket', connection: 'Upgrade' } })).status).toBe(501);
  });
});
