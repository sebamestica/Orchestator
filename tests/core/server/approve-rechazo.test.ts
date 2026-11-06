import { describe, expect, it } from 'vitest';
import { FleetService } from '../../../src/core/app/fleet-service.ts';
import type { TaskHooks } from '../../../src/core/server/index.ts';
import type { SqliteStore, TaskRecord } from '../../../src/core/store/index.ts';
import { task } from '../orchestrator/fakes.ts';
import { fakeMemory, makeTestApp } from './helpers.ts';

const PROJECT = 'proyecto-1';
const brief = (id: string, dependsOn: string[] = []) => task(id, { projectId: PROJECT, dependsOn });

/** App con ganchos propios, el proyecto creado y la última difusión de cada tarea por el hub. */
async function setup(hooks: TaskHooks) {
  const t = makeTestApp({ tasks: hooks });
  const res = await t.req('POST', '/projects', { body: { id: PROJECT, name: 'Proyecto', repoPath: 'C:\\dev\\proyecto' } });
  expect(res.status).toBe(201);
  const lastPublished = new Map<string, TaskRecord>();
  t.hub.subscribe((m) => {
    if (m.type === 'task') lastPublished.set(m.task.task.id, m.task);
  });
  return { ...t, lastPublished };
}

/** `FleetService` real sin agentes: la cola y sus ganchos, sin correr nada. */
function realFleet(store: SqliteStore): FleetService {
  const deps = {
    store,
    loadAdapters: async () => [],
    registry: { list: () => [] },
    quotaProviderFactory: async () => undefined,
    envFor: () => ({}),
    memory: fakeMemory(),
  } as unknown as ConstructorParameters<typeof FleetService>[0];
  return new FleetService(deps, {} as ConstructorParameters<typeof FleetService>[1]);
}

const conflict = (message: string) => Object.assign(new Error(message), { code: 'conflict' });

describe('aprobar una tarea que la flota rechaza', () => {
  it('responde 409 con el motivo, la devuelve a pending sin el agente nuevo y lo difunde', async () => {
    const t = await setup({
      onApproved: () => {
        throw conflict('La tarea bb depende de aa, que no está en la cola.');
      },
    });
    t.store.putTask(brief('aa'));
    t.store.putTask(brief('bb', ['aa']));
    await t.req('POST', '/agents', { body: { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' } });

    const res = await t.req('POST', '/tasks/bb/approve', { body: { agentId: 'codex' } });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({ code: 'conflict', message: expect.stringContaining('La tarea bb depende de aa, que no está en la cola.') });
    expect((await t.req('GET', '/tasks/bb')).json.task).toMatchObject({ state: 'pending', agentId: null });
    expect(t.lastPublished.get('bb')).toMatchObject({ state: 'pending', agentId: null });
    // Sigue aprobable: no queda `ready` fuera de la cola.
    expect(t.store.listTasks({ state: 'ready' })).toEqual([]);
  });

  it('un fallo inesperado del gancho (500) también la devuelve a pending', async () => {
    const t = await setup({
      onApproved: () => {
        throw new Error('no se pudo armar la flota');
      },
    });
    t.store.putTask(brief('suelta'));
    const res = await t.req('POST', '/tasks/suelta/approve');
    expect(res.status).toBe(500);
    expect(t.store.getTask('suelta')?.state).toBe('pending');
    expect(t.lastPublished.get('suelta')?.state).toBe('pending');
  });

  it('responde y difunde lo que dejó la cola dentro del gancho, no la foto de antes', async () => {
    const t = await setup({
      onApproved: (record) => {
        // Como `#copyChange` de la flota: la cola ya movió la tarea dentro del gancho.
        t.store.setTaskState(record.task.id, 'running', undefined, { detail: 'en curso' });
      },
    });
    t.store.putTask(brief('cc'));
    const res = await t.req('POST', '/tasks/cc/approve');
    expect(res.status).toBe(200);
    expect(res.json.task).toMatchObject({ state: 'running', detail: 'en curso' });
    expect(t.lastPublished.get('cc')).toMatchObject({ state: 'running' });
  });
});

describe('aprobar un plan', () => {
  it('aprueba en orden de dependencias aunque el plan liste antes la dependiente', async () => {
    const approved: string[] = [];
    const t = await setup({
      onApproved: (record) => {
        const missing = record.task.dependsOn.filter((dep) => !approved.includes(dep));
        if (missing.length) throw conflict(`La tarea ${record.task.id} depende de ${missing.join(', ')}, que no está en la cola.`);
        approved.push(record.task.id);
        expect(t.store.getTask(record.task.id)?.state).toBe('ready');
      },
    });
    const plan = t.store.createPlan({ id: 'plan-20261105-abcdef', projectId: PROJECT, text: 'B y A', tasks: [brief('bb', ['aa']), brief('aa')] });

    const res = await t.req('POST', `/plans/${plan.id}/approve`);
    expect(res.status).toBe(200);
    expect(approved).toEqual(['aa', 'bb']);
    expect((res.json.tasks as { task: { id: string }; state: string }[]).map((x) => [x.task.id, x.state])).toEqual([
      ['bb', 'ready'],
      ['aa', 'ready'],
    ]);
  });
});

describe('de punta a punta con la flota real', () => {
  it('aprobar bb mientras aa sigue pendiente responde 409 y deja bb pendiente y fuera de la cola', async () => {
    const hooks: TaskHooks = {};
    const t = await setup(hooks);
    const fleet = realFleet(t.store);
    Object.assign(hooks, fleet.hooks());
    t.store.putTask(brief('aa'));
    t.store.putTask(brief('bb', ['aa']));

    const res = await t.req('POST', '/tasks/bb/approve');
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({ message: expect.stringMatching(/depende de aa, que no está en la cola/) });
    expect(t.store.getTask('bb')?.state).toBe('pending');
    expect(fleet.queue.get('bb')).toBeUndefined();
    await fleet.stop();
  });

  it('aprobar otra vez una tarea que ya espera en la cola responde 409 y no la toca', async () => {
    const hooks: TaskHooks = {};
    const t = await setup(hooks);
    const fleet = realFleet(t.store);
    Object.assign(hooks, fleet.hooks());
    t.store.putTask(brief('aa'), 'ready');
    t.store.putTask(brief('bb', ['aa']), 'ready');
    fleet.queue.add(brief('aa'));
    fleet.queue.next();
    fleet.queue.add(brief('bb', ['aa']));
    const before = t.store.getTask('bb');
    expect(before?.state).toBe('ready');

    const res = await t.req('POST', '/tasks/bb/approve');
    expect(res.status).toBe(409);
    expect(t.store.getTask('bb')).toEqual(before);
    expect(fleet.queue.state('bb')).toBe('pending');
    await fleet.stop();
  });
});
