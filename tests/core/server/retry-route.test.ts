import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, loopbackHosts, type TaskHooks } from '../../../src/core/server/index.ts';
import { SqliteStore, type TaskRecord } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { taskBriefSchema, type TaskState } from '../../../src/shared/index.ts';
import { HOST, PORT, makeTestApp } from './helpers.ts';

const brief = (id: string) =>
  taskBriefSchema.parse({ id, projectId: 'demo', title: `Tarea ${id}`, objective: 'x', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['y'], difficulty: 'low' });

/** App con ganchos de orquestación propios (`onRetry`, `recover`). */
function appWith(hooks: TaskHooks, seed: (store: SqliteStore) => void = () => undefined) {
  const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
  seed(store);
  const token = generateToken();
  const hub = new EventHub(store);
  const published: TaskRecord[] = [];
  hub.subscribe((m) => {
    if (m.type === 'task') published.push(m.task);
  });
  const log: string[] = [];
  const core = createApp({
    token,
    allowedHosts: () => loopbackHosts(PORT),
    store,
    registry: new AgentRegistry({ store, vault: new MemoryVault(), detectors: [] }),
    hub,
    tasks: hooks,
    log: (l) => log.push(l),
    validateResponses: true,
  });
  const post = async (path: string) => {
    const res = await core.app.request(`http://${HOST}${path}`, { method: 'POST', headers: { host: HOST, authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { store, post, published, log };
}

describe('POST /tasks/:id/retry', () => {
  it('404 si no existe; 409 si no está fallida; 501 sin flota', async () => {
    const t = makeTestApp();
    t.store.putTask(brief('fallida'), 'failed');
    for (const state of ['integrated', 'running', 'pending', 'cancelled'] satisfies TaskState[]) t.store.putTask(brief(`en-${state}`), state);
    expect((await t.req('POST', '/tasks/no-existe/retry')).status).toBe(404);
    for (const state of ['integrated', 'running', 'pending', 'cancelled']) {
      const res = await t.req('POST', `/tasks/en-${state}/retry`);
      expect(res.status, state).toBe(409);
      expect((res.json.error as { message: string }).message).toMatch(new RegExp(`estado ${state}: solo se reintenta una tarea fallida`));
    }
    // La app de prueba no tiene `onRetry`: la flota no está configurada.
    expect((await t.req('POST', '/tasks/fallida/retry')).status).toBe(501);
  });

  it('con la flota: devuelve la tarea ya actualizada y la difunde', async () => {
    const calls: string[] = [];
    const a = appWith(
      {
        onRetry: (task) => {
          calls.push(task.task.id);
          a.store.setTaskState(task.task.id, 'ready', undefined, { detail: 'reintento pedido por el usuario' });
        },
      },
      (store) => {
        store.putTask(brief('t1'));
        store.setTaskState('t1', 'failed', 'codex', { detail: 'sin éxito tras 4 intentos' });
      },
    );
    const res = await a.post('/tasks/t1/retry');
    expect(res.status).toBe(200);
    expect(res.json.task).toMatchObject({ state: 'ready', detail: 'reintento pedido por el usuario', agentId: 'codex' });
    expect(calls).toEqual(['t1']);
    expect(a.published.at(-1)).toMatchObject({ state: 'ready' });
  });

  it('si la flota no la acepta (p. ej. una dependencia sin integrar) responde 409 con el motivo', async () => {
    const a = appWith(
      {
        onRetry: () => {
          throw Object.assign(new Error('La tarea t2 depende de base (failed), que no está integrada ni en la flota'), { code: 'conflict' });
        },
      },
      (store) => store.putTask(brief('t2'), 'failed'),
    );
    const res = await a.post('/tasks/t2/retry');
    expect(res.status).toBe(409);
    expect((res.json.error as { message: string }).message).toMatch(/depende de base/);
    expect(a.store.getTask('t2')?.state).toBe('failed');
  });
});

describe('arranque: recover', () => {
  it('se llama una vez al crear el servidor; si falla, se registra y el servidor arranca igual', () => {
    let calls = 0;
    appWith({ recover: () => { calls++; } });
    expect(calls).toBe(1);
    const broken = appWith({ recover: () => { throw new Error('base bloqueada'); } });
    expect(broken.log.join('\n')).toMatch(/no se pudo revisar las tareas interrumpidas: base bloqueada/);
  });
});

describe('POST /tasks/:id/cancel guarda el motivo', () => {
  it('con y sin razón', async () => {
    const t = makeTestApp();
    t.store.putTask(brief('c1'));
    t.store.putTask(brief('c2'));
    const withReason = await t.req('POST', '/tasks/c1/cancel', { body: { reason: 'Ya no hace falta' } });
    expect(withReason.json.task).toMatchObject({ state: 'cancelled', detail: 'Ya no hace falta' });
    const plain = await t.req('POST', '/tasks/c2/cancel', { body: {} });
    expect(plain.json.task).toMatchObject({ state: 'cancelled', detail: 'cancelada por el usuario' });
  });
});
