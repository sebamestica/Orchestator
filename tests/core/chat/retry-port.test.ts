import { describe, expect, it } from 'vitest';
import { lazyFleetPort } from '../../../src/core/app/f5-chat.ts';
import type { Composition } from '../../../src/core/app/compose.ts';

/** Flota falsa con lo que usa `lazyFleetPort`: cola, estado desde la base y reintento. */
function fakeFleet(retry: (taskId: string, reason?: string) => Promise<unknown>) {
  const calls: { taskId: string; reason?: string }[] = [];
  const fleet = {
    queue: { get: () => undefined, list: () => [] },
    status: (taskId: string) => ({ taskId, state: 'failed', detail: 'timeout: Plazo vencido' }),
    retry: async (taskId: string, reason?: string) => {
      calls.push({ taskId, ...(reason ? { reason } : {}) });
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
    expect(calls).toEqual([{ taskId: 'mercado-instagram-v2', reason: 'reintento pedido por la mente' }]);
  });

  it('si la flota rechaza el reintento, responde accepted: false con el motivo (tachado), sin lanzar', async () => {
    const { comp } = fakeFleet(async () => {
      throw new Error('La tarea x1 está en estado integrated: solo se reintenta una tarea fallida');
    });
    const result = await lazyFleetPort(comp).retry?.('x1');
    expect(result).toEqual({ accepted: false, reason: 'La tarea x1 está en estado integrated: solo se reintenta una tarea fallida' });
  });
});
