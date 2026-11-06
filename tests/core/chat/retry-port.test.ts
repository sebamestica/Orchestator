import { describe, expect, it } from 'vitest';
import { lazyFleetPort } from '../../../src/core/app/f5-chat.ts';
import type { Composition } from '../../../src/core/app/compose.ts';

/** Flota falsa con lo que usa `lazyFleetPort`: cola, estado desde la base y reintento. */
function fakeFleet(retry: (taskId: string, reason?: string) => Promise<unknown>) {
  const calls: { taskId: string; reason?: string; origin?: string }[] = [];
  const fleet = {
    queue: { get: () => undefined, list: () => [] },
    status: (taskId: string) => ({ taskId, state: 'failed', detail: 'timeout: Plazo vencido' }),
    retry: async (taskId: string, reason?: string, origin?: string) => {
      calls.push({ taskId, ...(reason ? { reason } : {}), ...(origin ? { origin } : {}) });
      return retry(taskId, reason);
    },
    port: async () => ({ delegate: async () => ({ accepted: true }) }),
  };
  return { comp: { fleet } as unknown as Pick<Composition, 'fleet'>, calls };
}

describe('chat de Berland: la mente puede reintentar tareas fallidas', () => {
  it('status trae el motivo desde la base y retry reencola con el motivo «reintento pedido por la mente»', async () => {
    const { comp, calls } = fakeFleet(async (taskId) => ({ task: { id: taskId }, state: 'ready', agentId: 'claude' }));
    const port = lazyFleetPort(comp);
    expect(await port.status('mercado-instagram-v2')).toMatchObject({ state: 'failed', detail: 'timeout: Plazo vencido' });
    expect(await port.retry?.('mercado-instagram-v2')).toEqual({ accepted: true, state: 'ready', agentId: 'claude' });
    // Con origen «mind»: la flota le aplica sus límites (no el reintento del usuario, que trae el tope entero).
    expect(calls).toEqual([{ taskId: 'mercado-instagram-v2', reason: 'reintento pedido por la mente', origin: 'mind' }]);
  });

  it('sin fila en la base (terminal), el estado del reintento sale de la cola', async () => {
    const { comp } = fakeFleet(async () => undefined);
    Object.assign(comp.fleet.queue, { get: () => ({ task: { id: 'x2' }, state: 'ready', agentId: 'claude' }) });
    expect(await lazyFleetPort(comp).retry?.('x2')).toEqual({ accepted: true, state: 'ready', agentId: 'claude' });
  });

  it('si la flota rechaza el reintento, responde accepted: false con el motivo (tachado), sin lanzar', async () => {
    const { comp } = fakeFleet(async () => {
      throw new Error('La tarea x1 está en estado integrated: solo se reintenta una tarea fallida');
    });
    const result = await lazyFleetPort(comp).retry?.('x1');
    expect(result).toEqual({ accepted: false, reason: 'La tarea x1 está en estado integrated: solo se reintenta una tarea fallida' });
  });

  it('list incluye las tareas de la base que la cola no tiene (tras reiniciar el núcleo), con su proyecto y su motivo', async () => {
    const saved = (id: string, state: string, detail: string | null) => ({
      task: { id, projectId: 'p' }, state, agentId: null, detail, attempts: 1, updatedAt: '2026-11-05T10:00:00.000Z',
    });
    const rows = [saved('api', 'integrated', null), saved('ui', 'failed', 'interrumpida al reiniciar el núcleo')];
    const { comp } = fakeFleet(async () => undefined);
    const store = { listTasks: () => rows, getTask: (id: string) => rows.find((r) => r.task.id === id) };
    const port = lazyFleetPort({ ...comp, store } as unknown as Pick<Composition, 'fleet' | 'store'>);
    const list = await port.list();
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'api', state: 'integrated', projectId: 'p' }),
        expect.objectContaining({ taskId: 'ui', state: 'failed', detail: 'interrumpida al reiniciar el núcleo', projectId: 'p' }),
      ]),
    );
  });
});
