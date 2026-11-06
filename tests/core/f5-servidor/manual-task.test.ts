import { describe, expect, it } from 'vitest';
import { MANUAL_DEFAULT_ACCEPTANCE } from '../../../src/core/app/f5-servidor.ts';
import { apiSchemas } from '../../../src/core/server/index.ts';
import { makeF5App, putAgent } from './helpers.ts';

const body = {
  projectId: 'vetworld',
  title: '  Corregir la fecha de las citas  ',
  objective: 'Las citas del lunes salen con un día de desfase.',
  ownedPaths: ['src/citas/**'],
};

function setup() {
  const t = makeF5App();
  t.store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: 'C:\\dev\\Vetworld' });
  putAgent(t.store, 'codex', 'codex-cli');
  return t;
}

describe('POST /tasks/manual', () => {
  it('arma el encargo completo y, por defecto, lo aprueba como POST /tasks/:id/approve', async () => {
    const t = setup();
    const res = await t.req('POST', '/tasks/manual', { body: { ...body, agentId: 'codex' } });
    expect(res.status, res.text).toBe(201);
    const { task } = apiSchemas.taskResponse.parse(res.json);
    expect(task.task.id).toMatch(/^manual-\d{8}-[0-9a-f]{6}$/);
    expect(task).toMatchObject({ state: 'ready', agentId: 'codex' });
    expect(task.task).toEqual({
      id: task.task.id,
      projectId: 'vetworld',
      title: 'Corregir la fecha de las citas',
      objective: body.objective,
      ownedPaths: ['src/citas/**'],
      dependsOn: [],
      acceptance: [MANUAL_DEFAULT_ACCEPTANCE],
      difficulty: 'medium',
      suggestedAgent: 'codex',
      contextRefs: [],
      skillRefs: [],
    });
    // La misma lógica de aprobación: gancho de la orquestación, estado guardado y difusión.
    expect(t.approved.map((r) => r.task.id)).toEqual([task.task.id]);
    expect(t.store.getTask(task.task.id)?.state).toBe('ready');
    expect(t.messages.filter((m) => m.type === 'task').map((m) => (m.type === 'task' ? m.task.state : ''))).toEqual(['pending', 'ready']);
  });

  it('con approve: false queda pendiente y respeta la aceptación dada', async () => {
    const t = setup();
    const res = await t.req('POST', '/tasks/manual', { body: { ...body, acceptance: ['Las pruebas de citas pasan'], approve: false } });
    expect(res.status).toBe(201);
    const { task } = apiSchemas.taskResponse.parse(res.json);
    expect(task.state).toBe('pending');
    expect(task.task.acceptance).toEqual(['Las pruebas de citas pasan']);
    expect(task.task.suggestedAgent).toBeUndefined();
    expect(t.approved).toEqual([]);
    // Después se aprueba con la ruta de siempre.
    expect((await t.req('POST', `/tasks/${task.task.id}/approve`, { body: {} })).status).toBe(200);
    expect(t.approved).toHaveLength(1);
  });

  it('proyecto o agente inexistentes → 404; cuerpo inválido → 400', async () => {
    const t = setup();
    expect((await t.req('POST', '/tasks/manual', { body: { ...body, projectId: 'otro' } })).status).toBe(404);
    expect((await t.req('POST', '/tasks/manual', { body: { ...body, agentId: 'fantasma' } })).status).toBe(404);
    for (const bad of [{ ...body, ownedPaths: [] }, { ...body, title: '   ' }, { ...body, extra: 1 }]) {
      expect((await t.req('POST', '/tasks/manual', { body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(t.store.listTasks()).toEqual([]);
  });

  it.each([['C:\\dev\\x\\**'], ['../y/**'], ['!src'], ['/src/**'], ['@(a|b)/**']])(
    'ruta propia inválida %s → 400 sin crear ni aprobar nada',
    async (bad) => {
      const t = setup();
      const res = await t.req('POST', '/tasks/manual', { body: { ...body, ownedPaths: ['src/citas/**', bad] } });
      expect(res.status, res.text).toBe(400);
      const { error } = apiSchemas.errorResponse.parse(res.json);
      expect(error.code).toBe('invalid_request');
      expect(error.message).toContain(`«${bad}»`);
      expect(t.store.listTasks()).toEqual([]);
      expect(t.approved).toEqual([]);
    },
  );
});
