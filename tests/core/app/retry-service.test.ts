import { afterEach, describe, expect, it } from 'vitest';
import { FleetService, INTERRUPTED_DETAIL, MAX_MIND_RETRIES, RetryError } from '../../../src/core/app/fleet-service.ts';
import type { FleetTaskStatus } from '../../../src/core/conductor/index.ts';
import { BUDGET_STOP_DETAIL } from '../../../src/core/orchestrator/index.ts';
import { SqliteStore, type TaskRecord } from '../../../src/core/store/index.ts';
import { REDACTED, type AgentEvent, type TaskState } from '../../../src/shared/index.ts';
import { task } from '../orchestrator/fakes.ts';

const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

/** `FleetService` sin armar la flota (no hacen falta adaptadores para la cola, el almacén y el arranque). */
function service() {
  const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
  stores.push(store);
  const log: string[] = [];
  const deps = { store } as unknown as ConstructorParameters<typeof FleetService>[0];
  const fleet = new FleetService(deps, {} as ConstructorParameters<typeof FleetService>[1], {}, (l) => log.push(l));
  const published: TaskRecord[] = [];
  const events: AgentEvent[] = [];
  fleet.attachSink({ append: (e) => events.push(e), publishTask: (t) => published.push(t) });
  return { store, fleet, log, published };
}

describe('FleetService: el motivo de cada cambio llega a la base y a la interfaz', () => {
  it('guarda el detalle tachado, cuenta los intentos y difunde cada cambio', () => {
    const { store, fleet, published } = service();
    store.putTask(task('t1'), 'ready');
    fleet.queue.add(task('t1'));
    fleet.queue.next();
    fleet.queue.assign('t1', 'codex');
    const key = `sk-ant-api03-${'X'.repeat(40)}`;
    fleet.queue.transition('t1', 'failed', { agentId: 'codex', detail: `t1: sin éxito tras 4 intentos (último: timeout (${key}))` });

    const saved = store.getTask('t1');
    expect(saved).toMatchObject({ state: 'failed', agentId: 'codex', attempts: 1 });
    expect(saved?.detail).toContain('sin éxito tras 4 intentos');
    expect(saved?.detail).toContain(REDACTED);
    expect(saved?.detail).not.toContain('sk-ant-api03');
    // Ya aprobada (`ready` en la base): el `pending` con que entra a la cola no la devuelve a «sin aprobar».
    expect(published.map((t) => t.state)).toEqual(['ready', 'ready', 'running', 'failed']);
    expect(published.at(-1)?.detail).toBe(saved?.detail);

    // Un cambio sin motivo lo borra (el motivo es el del último cambio) y un nuevo arranque suma un intento.
    fleet.queue.retry('t1', 'reintento pedido por el usuario');
    expect(store.getTask('t1')).toMatchObject({ state: 'ready', detail: 'reintento pedido por el usuario' });
    fleet.queue.next();
    expect(store.getTask('t1')).toMatchObject({ state: 'running', detail: null, attempts: 2 });
  });

  it('un destino sin publishTask (SQLite) no difunde nada y no falla', () => {
    const { store, fleet } = service();
    fleet.attachSink(store);
    store.putTask(task('t2'), 'ready');
    fleet.queue.add(task('t2'));
    expect(store.getTask('t2')?.state).toBe('ready');
  });
});

describe('FleetService.recoverOrphans (arranque del núcleo)', () => {
  it('las tareas en curso que la cola no tiene pasan a failed con el motivo y las sesiones abiertas se cancelan', () => {
    const { store, fleet, log, published } = service();
    const states: [string, TaskState][] = [
      ['corriendo', 'running'],
      ['revisando', 'review'],
      ['traspasada', 'handed_off'],
      ['lista', 'ready'],
      ['pendiente', 'pending'],
      ['integrada', 'integrated'],
      ['cancelada', 'cancelled'],
      ['fallida', 'failed'],
    ];
    for (const [id, state] of states) store.putTask(task(id), state);
    store.append({ sessionId: 'worker-1', agentId: 'codex', seq: 0, ts: '2026-11-04T23:00:00.000Z', type: 'text', payload: { text: 'a medias', role: 'assistant' } });
    store.append({ sessionId: 'chat-1', agentId: 'orquestador', seq: 0, ts: '2026-11-04T23:00:00.000Z', type: 'text', payload: { text: 'hola', role: 'assistant' } });

    const recovered = fleet.recoverOrphans();
    expect(recovered.map((t) => t.task.id).sort()).toEqual(['corriendo', 'lista', 'revisando', 'traspasada']);
    for (const id of ['corriendo', 'revisando', 'traspasada', 'lista']) {
      expect(store.getTask(id)).toMatchObject({ state: 'failed', detail: INTERRUPTED_DETAIL });
    }
    expect(store.getTask('pendiente')?.state).toBe('pending');
    expect(store.getTask('integrada')?.state).toBe('integrated');
    expect(store.getTask('cancelada')?.state).toBe('cancelled');
    expect(store.getTask('fallida')).toMatchObject({ state: 'failed', detail: null });
    expect(published.map((t) => t.task.id).sort()).toEqual(['corriendo', 'lista', 'revisando', 'traspasada']);
    expect(store.getSession('worker-1')?.state).toBe('cancelled');
    // La sesión de la mente la retoma su chat.
    expect(store.getSession('chat-1')?.state).toBe('running');
    expect(log.join('\n')).toMatch(/4 tarea\(s\) interrumpida al reiniciar el núcleo/);
    // Una segunda pasada no hace nada.
    expect(fleet.recoverOrphans()).toEqual([]);
  });

  it('no toca las tareas que la cola sí tiene (el núcleo sigue vivo) ni sus sesiones', () => {
    const { store, fleet } = service();
    store.putTask(task('viva'), 'ready');
    fleet.queue.add(task('viva'));
    fleet.queue.next();
    store.append({ sessionId: 'worker-viva', agentId: 'codex', seq: 0, ts: '2026-11-04T23:00:00.000Z', type: 'text', payload: { text: 'sigo', role: 'assistant' } });
    expect(fleet.recoverOrphans()).toEqual([]);
    expect(store.getTask('viva')?.state).toBe('running');
    expect(store.getSession('worker-viva')?.state).toBe('running');
  });
});

describe('FleetService.retry: errores', () => {
  it('404 si no existe y 409 si no está fallida, antes de armar la flota', async () => {
    const { store, fleet } = service();
    await expect(fleet.retry('no-existe')).rejects.toMatchObject({ name: 'RetryError', code: 'not_found' });
    store.putTask(task('integrada'), 'integrated');
    const err = await fleet.retry('integrada').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryError);
    expect(err).toMatchObject({ code: 'conflict', message: expect.stringMatching(/estado integrated/) });
  });

  it('el estado para la mente sale de la base si la cola no tiene la tarea', () => {
    const { store, fleet } = service();
    store.putTask(task('vieja'), 'failed');
    store.setTaskState('vieja', 'failed', 'codex', { detail: INTERRUPTED_DETAIL });
    expect(fleet.status('vieja')).toMatchObject({ taskId: 'vieja', state: 'failed', agentId: 'codex', detail: INTERRUPTED_DETAIL });
    store.putTask(task('nueva'), 'pending');
    expect(fleet.status('nueva')).toBeUndefined();
  });
});

describe('FleetService: una tarea aprobada que espera a sus dependencias', () => {
  it('sigue ready en la base con el motivo «esperando a …» y nunca se difunde como pending', () => {
    const { store, fleet, published } = service();
    store.putTask(task('ta'), 'ready');
    store.putTask(task('tb', { dependsOn: ['ta'] }), 'ready');
    fleet.queue.add(task('ta'));
    fleet.queue.next();
    fleet.queue.add(task('tb', { dependsOn: ['ta'] }));

    expect(fleet.queue.state('tb')).toBe('pending');
    expect(store.getTask('tb')).toMatchObject({ state: 'ready', detail: 'esperando a ta' });
    const ofB = published.filter((t) => t.task.id === 'tb');
    expect(ofB.length).toBeGreaterThan(0);
    expect(ofB.some((t) => t.state === 'pending')).toBe(false);

    // Al integrarse la dependencia, la cola la libera y la base pierde el motivo de la espera.
    fleet.queue.transition('ta', 'review');
    fleet.queue.transition('ta', 'integrated');
    expect(fleet.queue.state('tb')).toBe('ready');
    expect(store.getTask('tb')).toMatchObject({ state: 'ready', detail: null });
    expect(fleet.queue.next()?.id).toBe('tb');
    expect(store.getTask('tb')).toMatchObject({ state: 'running', attempts: 1 });
  });

  it('tras un reinicio, la que esperaba queda fallida y reintentable (no «sin aprobar»)', () => {
    const { store, fleet } = service();
    store.putTask(task('ta'), 'ready');
    store.putTask(task('tb', { dependsOn: ['ta'] }), 'ready');
    fleet.queue.add(task('ta'));
    fleet.queue.add(task('tb', { dependsOn: ['ta'] }));

    const restarted = service();
    for (const id of ['ta', 'tb']) {
      const saved = store.getTask(id);
      if (saved) restarted.store.putTask(saved.task, saved.state);
    }
    expect(restarted.fleet.recoverOrphans().map((t) => t.task.id).sort()).toEqual(['ta', 'tb']);
    expect(restarted.store.getTask('tb')).toMatchObject({ state: 'failed', detail: INTERRUPTED_DETAIL });
  });
});

describe('FleetService.retry: la mente no reintenta sin límite (cada reintento trae el tope de gasto entero)', () => {
  /**
   * Flota armada falsa: acepta el reintento y deja la tarea en `ready`, como la cola. Su `status` es el de la base salvo
   * lo que diga `live` (el motivo en vivo que solo tiene la flota armada).
   */
  function withPort(s: ReturnType<typeof service>, live = new Map<string, FleetTaskStatus>()): string[] {
    const retried: string[] = [];
    Object.assign(s.fleet, {
      port: async () => ({
        status: (taskId: string) => live.get(taskId) ?? s.fleet.status(taskId),
        retry: async (taskId: string) => {
          retried.push(taskId);
          s.store.setTaskState(taskId, 'ready');
          return { accepted: true };
        },
      }),
    });
    return retried;
  }
  const fail = (s: ReturnType<typeof service>, taskId: string, detail: string) => s.store.setTaskState(taskId, 'failed', 'claude', { detail });
  const BUDGET = `${BUDGET_STOP_DETAIL}: 8.10 de 8 USD (dificultad high); lo hecho queda en .orq/HANDOFF.md: reintenta para continuar desde ahí`;

  it('una tarea detenida por el tope de gasto: la mente no puede reintentarla, el usuario sí', async () => {
    const s = service();
    const retried = withPort(s);
    s.store.putTask(task('cara'), 'running');
    fail(s, 'cara', BUDGET);
    expect(s.fleet.status('cara')).toMatchObject({ state: 'failed', budgetStop: true });
    const err = await s.fleet.retry('cara', 'x', 'mind').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryError);
    expect(err).toMatchObject({ code: 'conflict', message: expect.stringMatching(/tope de gasto: solo el usuario puede reintentarla desde el tablero/) });
    expect(retried).toEqual([]);
    await s.fleet.retry('cara', 'reintento pedido por el usuario');
    expect(retried).toEqual(['cara']);
  });

  it('una tarea que solo está en la cola (terminal) y se detuvo por el tope: la flota armada lo sabe y la mente no la reintenta', async () => {
    const s = service();
    const live = new Map<string, FleetTaskStatus>();
    const retried = withPort(s, live);
    s.fleet.queue.add(task('suelta'));
    s.fleet.queue.next();
    s.fleet.queue.assign('suelta', 'claude');
    s.fleet.queue.transition('suelta', 'failed', { agentId: 'claude', detail: BUDGET });
    // Sin fila en la base, el estado de FleetService no trae el motivo; el de la flota armada sí.
    expect(s.fleet.status('suelta')?.budgetStop).toBeUndefined();
    live.set('suelta', { taskId: 'suelta', state: 'failed', detail: BUDGET, budgetStop: true });
    await expect(s.fleet.retry('suelta', 'x', 'mind')).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/solo el usuario/) });
    expect(retried).toEqual([]);
  });

  it(`por otro motivo, la mente reintenta como mucho ${MAX_MIND_RETRIES} veces; un reintento del usuario le devuelve la cuenta`, async () => {
    const s = service();
    const retried = withPort(s);
    s.store.putTask(task('lenta'), 'running');
    expect(s.fleet.status('lenta')?.budgetStop).toBeUndefined();
    for (let i = 0; i < MAX_MIND_RETRIES; i++) {
      fail(s, 'lenta', 'timeout: plazo vencido');
      await s.fleet.retry('lenta', 'x', 'mind');
    }
    fail(s, 'lenta', 'timeout: plazo vencido');
    await expect(s.fleet.retry('lenta', 'x', 'mind')).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/ya reintentó lenta 2 veces: pídele al usuario/) });
    await s.fleet.retry('lenta', 'reintento pedido por el usuario', 'user');
    fail(s, 'lenta', 'timeout: plazo vencido');
    await s.fleet.retry('lenta', 'x', 'mind');
    expect(retried).toHaveLength(MAX_MIND_RETRIES + 2);
  });
});
