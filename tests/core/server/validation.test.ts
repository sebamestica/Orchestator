import { describe, expect, it } from 'vitest';
import { apiSchemas } from '../../../src/core/server/index.ts';
import { fakeKey, makeTestApp } from './helpers.ts';

function expectError(res: { status: number; json: unknown }, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = apiSchemas.errorResponse.parse(res.json);
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
}

describe('validación de cuerpos con Zod', () => {
  const task = {
    id: 'tarea-1',
    projectId: 'proyecto-1',
    title: 'T',
    objective: 'O',
    ownedPaths: ['src/**'],
    dependsOn: [],
    acceptance: ['ok'],
    difficulty: 'low',
  };
  const cases: [string, string, unknown][] = [
    ['POST', '/agents', {}],
    ['POST', '/agents', { provider: 'anthropic', apiKey: 123, displayName: 'x' }],
    ['POST', '/agents', { provider: 'desconocido', apiKey: 'sk-1234567890', displayName: 'x' }],
    ['POST', '/agents', { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex', secretRef: 'robada' }],
    ['POST', '/agents', [1, 2]],
    ['PATCH', '/agents/agente-1', { quotaFloor: 2 }],
    ['PATCH', '/agents/agente-1', { secretRef: 'otra' }],
    ['POST', '/quotas/refresh', { agentId: 'NO VALIDO' }],
    ['POST', '/projects', { id: 'p', name: 'x', repoPath: 'C:\\x' }],
    ['POST', '/projects', { id: 'proyecto-1', name: '', repoPath: 'C:\\x' }],
    ['POST', '/plans', { projectId: 'proyecto-1', text: '   ' }],
    ['POST', '/plans', { projectId: 'proyecto-1', text: 'x'.repeat(100_001) }],
    ['POST', '/tasks', { ...task, ownedPaths: [] }],
    ['POST', '/tasks', { ...task, difficulty: 'extrema' }],
    ['POST', '/tasks', { ...task, extra: 1 }],
    ['POST', '/tasks', { ...task, ownedPaths: ['C:\\x\\**'] }],
    ['POST', '/tasks', { ...task, ownedPaths: ['src/**', '../y/**'] }],
    ['POST', '/tasks', { ...task, ownedPaths: ['!src'] }],
    ['POST', '/tasks', { ...task, ownedPaths: ['/src/**'] }],
    ['POST', '/tasks', { ...task, ownedPaths: ['@(a|b)/**'] }],
    ['POST', '/tasks/tarea-1/approve', { agentId: 5 }],
    ['POST', '/tasks/tarea-1/cancel', { reason: '' }],
    ['POST', '/skills/import', { source: '' }],
    ['POST', '/skills/import', {}],
  ];

  it.each(cases)('%s %s → 400 con {error:{code,message}}', async (method, path, body) => {
    const t = makeTestApp();
    expectError(await t.req(method, path, { body }), 400, 'invalid_request');
  });

  it('JSON inválido, sin cuerpo, Content-Type equivocado y cuerpo demasiado grande', async () => {
    const t = makeTestApp({ maxBodyBytes: 2048 });
    expectError(await t.req('POST', '/projects', { rawBody: '{"id": ', headers: { 'content-type': 'application/json' } }), 400, 'invalid_json');
    expectError(await t.req('POST', '/projects'), 400, 'invalid_request');
    expectError(await t.req('POST', '/projects', { rawBody: '{"id":"a"}', headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type');
    expectError(await t.req('POST', '/plans', { body: { projectId: 'proyecto-1', text: 'x'.repeat(5000) } }), 413, 'payload_too_large');
    // Cuerpo opcional: vacío equivale a {}.
    expect((await t.req('POST', '/quotas/refresh')).status).toBe(200);
  });

  it('el mensaje de error no repite valores de la entrada (p. ej. una clave)', async () => {
    const t = makeTestApp();
    const key = fakeKey();
    const res = await t.req('POST', '/agents', { body: { provider: 'nope', apiKey: key, displayName: 'x', extra: key } });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(key);
  });
});

describe('validación de parámetros y consultas', () => {
  const cases: [string, string][] = [
    ['GET', '/agents/MAYUSCULAS'],
    ['GET', '/agents/a'],
    ['DELETE', '/agents/con%20espacio'],
    ['POST', '/agents/-x/probe'],
    ['GET', '/projects/a_b'],
    ['POST', '/skills/..%2F..%2Fwindows/approve'],
    ['POST', '/skills/a..b/reject'],
    ['GET', '/quotas?agentId=X'],
    ['GET', '/quotas?otro=1'],
    ['GET', '/tasks?state=inventado'],
    ['GET', '/sessions?limit=0'],
    ['GET', '/sessions/s1/events?since=abc'],
    ['GET', '/sessions/s1/events?since=-2'],
    ['GET', '/sessions/s1/events?limit=5001'],
    ['GET', '/usage?groupBy=agent,color'],
    ['GET', '/usage?from=2026-1-1'],
    ['GET', '/memory/proyecto-1/context?budget=10'],
    ['GET', '/memory/PROYECTO/context'],
  ];
  it.each(cases)('%s %s → 400', async (method, path) => {
    const t = makeTestApp();
    expectError(await t.req(method, path), 400, 'invalid_request');
  });

  it('ruta o método desconocidos → 404 JSON', async () => {
    const t = makeTestApp();
    expectError(await t.req('GET', '/no-existe'), 404, 'not_found');
    expectError(await t.req('PUT', '/agents'), 404, 'not_found');
  });
});
