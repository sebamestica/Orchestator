import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/shared/index.ts';
import { fillPath, makeTestApp } from './helpers.ts';

/**
 * Recorre todas las rutas GET (y las respuestas de las mutaciones) con datos que contienen una clave
 * y comprueba que ninguna respuesta, ni el registro, la devuelve: ni la clave, ni su base64, ni el token.
 */
describe('ninguna ruta devuelve secretos', () => {
  it('recorrido completo de las rutas', async () => {
    const t = makeTestApp();
    const key = t.validKey;
    const forbidden = [key, Buffer.from(key).toString('base64'), key.slice(-24), t.token];
    const bodies: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await t.req(method, path, body === undefined ? {} : { body });
      bodies.push(`${method} ${path} ${res.status}\n${res.text}`);
      return res;
    };

    // Mutaciones con la clave dentro de los datos.
    const added = await call('POST', '/agents', { provider: 'anthropic', apiKey: key, displayName: 'Claude', id: 'claude' });
    expect(added.status).toBe(201);
    await call('POST', '/agents', { provider: 'openai', apiKey: key, displayName: 'GPT', id: 'gpt' });
    await call('POST', '/agents', { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
    await call('POST', '/agents', { id: 'roto-cupo', kind: 'agy-cli', provider: 'antigravity', displayName: 'Roto' });
    await call('PATCH', '/agents/claude', { displayName: 'Claude principal' });
    await call('POST', '/agents/claude/probe');
    await call('POST', '/agents/detect');
    await call('POST', '/quotas/refresh', {});
    await call('POST', '/projects', { id: 'proyecto-1', name: `Proyecto ${key}`, repoPath: 'C:\\dev\\p' });
    const plan = await call('POST', '/plans', { projectId: 'proyecto-1', text: `Usa la clave ${key} para todo` });
    const planId = (plan.json.plan as { id: string }).id;
    const taskId = (plan.json.tasks as { task: { id: string } }[])[0]?.task.id ?? '';
    await call('POST', '/tasks', {
      id: 'tarea-secreta',
      projectId: 'proyecto-1',
      title: 'Con clave',
      objective: `export ANTHROPIC_API_KEY=${key}`,
      ownedPaths: ['src/**'],
      dependsOn: [],
      acceptance: [`no imprimir ${key}`],
      difficulty: 'low',
    });
    await call('POST', `/tasks/${taskId}/approve`, {});
    await call('POST', '/tasks/tarea-secreta/cancel', { reason: `por ${key}` });
    await call('POST', `/plans/${planId}/approve`);
    await call('POST', '/skills/import', { source: `C:\\${key}.zip` });
    await call('POST', '/skills/nueva-1/approve');
    await call('POST', '/skills/nueva-2/reject');

    // Eventos que traen la clave (p. ej. un agente que imprime su entorno).
    const events: AgentEvent[] = [
      { sessionId: 'ses-1', agentId: 'claude', seq: 0, ts: '2026-11-01T12:00:00.000Z', type: 'status', payload: { state: 'running', detail: `key=${key}` } },
      { sessionId: 'ses-1', agentId: 'claude', seq: 1, ts: '2026-11-01T12:00:01.000Z', type: 'text', payload: { text: `Mi clave es ${key}`, role: 'assistant' } },
      { sessionId: 'ses-1', agentId: 'claude', seq: 2, ts: '2026-11-01T12:00:02.000Z', type: 'tool_call', payload: { callId: 'c1', name: 'Bash', inputSummary: `curl -H "x-api-key: ${key}"` } },
      { sessionId: 'ses-1', agentId: 'claude', seq: 3, ts: '2026-11-01T12:00:03.000Z', type: 'usage', payload: { inputTokens: 1, outputTokens: 1, model: 'opus' } },
      { sessionId: 'ses-1', agentId: 'claude', seq: 4, ts: '2026-11-01T12:00:04.000Z', type: 'error', payload: { code: 'auth', message: `401 con ${key}` } },
      { sessionId: 'ses-1', agentId: 'claude', seq: 5, ts: '2026-11-01T12:00:05.000Z', type: 'done', payload: { ok: false, summary: key } },
    ];
    for (const e of events) t.hub.append(e);

    // Todas las rutas GET con los ids reales.
    const values = { id: 'claude', project: 'proyecto-1', name: 'nueva-1' };
    const idFor: Record<string, string> = {
      '/agents/:id': 'claude',
      '/projects/:id': 'proyecto-1',
      '/plans/:id': planId,
      '/tasks/:id': 'tarea-secreta',
      '/sessions/:id': 'ses-1',
      '/sessions/:id/events': 'ses-1',
    };
    const queries: Record<string, string> = {
      '/usage': '?groupBy=agent,day,session,model',
      '/memory/:project/context': '?taskId=tarea-secreta',
      '/sessions/:id/events': '?since=-1',
    };
    const visited = new Set<string>();
    for (const spec of t.routes) {
      if (spec.method !== 'get' || spec.websocket) continue;
      const path = fillPath(spec.path, { ...values, ...(idFor[spec.path] ? { id: idFor[spec.path] ?? '' } : {}) });
      const res = await call('GET', `${path}${queries[spec.path] ?? ''}`);
      expect(res.status, `GET ${path}`).toBe(200);
      visited.add(spec.path);
    }
    expect([...visited].sort()).toEqual(t.routes.filter((r) => r.method === 'get' && !r.websocket).map((r) => r.path).sort());
    expect(visited.size).toBeGreaterThanOrEqual(15);

    // Errores también.
    await call('POST', '/agents', { provider: 'openai', apiKey: `${key}x`, displayName: 'Mala' });
    await call('POST', '/agents', { provider: 'nope', apiKey: key, displayName: 'x' });

    const all = bodies.join('\n');
    expect(all).toContain('[REDACTADO]');
    for (const secret of forbidden) expect(all).not.toContain(secret);
    for (const secret of forbidden) expect(t.logLines.join('\n')).not.toContain(secret);
    // La clave sí está en la bóveda (y solo ahí).
    const refs = await t.vault.list();
    expect(refs).toHaveLength(2);
    expect(await t.vault.get(refs[0]?.ref ?? '')).toBe(key);
    expect(JSON.stringify(refs)).not.toContain(key);
  });

  it('los mensajes del hub (WebSocket) llegan tachados', async () => {
    const t = makeTestApp();
    const got: string[] = [];
    t.hub.subscribe((m) => got.push(JSON.stringify(m)));
    t.hub.append({ sessionId: 's', agentId: 'claude', seq: 0, ts: '2026-11-01T12:00:00.000Z', type: 'text', payload: { text: `x ${t.validKey}`, role: 'assistant' } });
    t.hub.publishQuota({ agentId: 'claude', method: 'manual-budget', takenAt: '2026-11-01T12:00:00.000Z', buckets: [], stale: false, error: `fallo ${t.validKey}` });
    expect(got).toHaveLength(2);
    expect(got.join('\n')).not.toContain(t.validKey);
  });
});
