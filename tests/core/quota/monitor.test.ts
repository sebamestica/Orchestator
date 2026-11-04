import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexQuotaProvider } from '../../../src/core/quota/codex.ts';
import { QuotaMonitor } from '../../../src/core/quota/monitor.ts';
import type { QuotaSnapshot } from '../../../src/shared/quota.ts';

let base: QuotaSnapshot;
const monitors: QuotaMonitor[] = [];
beforeEach(async () => {
  const text = await readFile(new URL('../../../fixtures/codex/app-server-synthetic.json', import.meta.url), 'utf8');
  base = await new CodexQuotaProvider('codex-test', { readAppServer: async (): Promise<unknown> => JSON.parse(text) as unknown }).read();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
});
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.stop(); vi.useRealTimers(); });
function monitor(read: () => Promise<QuotaSnapshot>, options: ConstructorParameters<typeof QuotaMonitor>[1] = {}) {
  const result = new QuotaMonitor([{ agentId: base.agentId, read }], options);
  monitors.push(result);
  return result;
}
const fraction = (value: number): QuotaSnapshot => ({ ...base, buckets: base.buckets.map((bucket) => ({ ...bucket, remainingFraction: value })) });

describe('monitor de cupos', () => {
  it('lee cada cinco minutos, a pedido y al terminar; stop libera el reloj', async () => {
    const read = vi.fn(async () => base);
    const snapshots = vi.fn();
    const m = monitor(read, { onSnapshot: snapshots });
    expect(m.latest(base.agentId)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await m.refresh();
    await m.onTaskDone(base.agentId);
    expect(read).toHaveBeenCalledTimes(3);
    expect(snapshots).toHaveBeenCalledTimes(3);
    expect(m.all()).toEqual([base]);
    m.stop(); m.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reutiliza la misma promesa incluso durante ticks y onTaskDone', async () => {
    let resolve!: (value: QuotaSnapshot) => void;
    const read = vi.fn(() => new Promise<QuotaSnapshot>((done) => { resolve = done; }));
    const m = monitor(read, { intervalMs: 10 });
    const first = m.refresh(base.agentId);
    expect(m.refresh(base.agentId)).toBe(first);
    expect(m.onTaskDone(base.agentId)).toBe(first);
    await vi.advanceTimersByTimeAsync(50);
    expect(read).toHaveBeenCalledOnce();
    resolve(base);
    await first;
    const second = m.refresh(base.agentId);
    expect(second).not.toBe(first);
    await Promise.resolve(); resolve(base); await second;
  });

  it('conserva la última foto buena y su fecha ante rechazo y error declarado', async () => {
    const read = vi.fn(async () => base);
    const m = monitor(read);
    await m.refresh();
    read.mockRejectedValueOnce(new Error('Sin conexión'));
    expect(await m.onTaskDone(base.agentId)).toEqual({ ...base, stale: true, error: 'Sin conexión' });
    read.mockResolvedValueOnce({ ...base, buckets: [], error: 'Sin cupo disponible' });
    expect((await m.refresh(base.agentId)).buckets).toEqual(base.buckets);
    await m.refresh();
    expect(m.latest(base.agentId)).toEqual(base);
    const copy = m.all(); copy[0]?.buckets.splice(0);
    expect(m.latest(base.agentId)?.buckets).toHaveLength(2);
  });

  it('expone fallo inicial con reloj inyectado y valida identidad y datos', async () => {
    const read = vi.fn(async () => ({ ...base, agentId: 'otro' }));
    const m = monitor(read, { now: () => new Date('2026-10-01T00:00:00Z') });
    expect(await m.refresh(base.agentId)).toMatchObject({ buckets: [], stale: true, takenAt: '2026-10-01T00:00:00.000Z', error: expect.any(String) });
    read.mockResolvedValueOnce({ ...base, buckets: [{ groupId: 'codex', groupName: 'Codex', window: '5h', remainingFraction: 2 }] });
    expect((await m.refresh(base.agentId)).error).toBeDefined();
    await expect(m.refresh('desconocido')).rejects.toThrow('desconocido');
  });

  it('emite 25 y 10 una vez por cruce y ventana, y rearma al subir', async () => {
    const onAlert = vi.fn();
    let snapshot = fraction(0.5);
    const m = monitor(async () => snapshot, { onAlert });
    await m.refresh();
    snapshot = fraction(0.25); await m.refresh(); await m.refresh();
    expect(onAlert).toHaveBeenCalledTimes(2);
    snapshot = fraction(0.1); await m.refresh(); await m.refresh();
    expect(onAlert).toHaveBeenCalledTimes(4);
    expect(onAlert.mock.calls.map(([alert]) => alert.threshold)).toEqual([0.25, 0.25, 0.1, 0.1]);
    snapshot = fraction(0.2); await m.refresh();
    snapshot = fraction(0.09); await m.refresh();
    expect(onAlert).toHaveBeenCalledTimes(6);
    snapshot = fraction(0.8); await m.refresh();
    snapshot = fraction(0.05); await m.refresh();
    expect(onAlert).toHaveBeenCalledTimes(10);
  });

  it('aísla agentes y grupos, admite umbrales y temporizadores inyectados', async () => {
    const onAlert = vi.fn();
    const clear = vi.fn();
    const set = vi.fn(() => 123);
    const second = { ...fraction(0.3), agentId: 'segundo' };
    const snapshot = { ...fraction(0.3), buckets: [...fraction(0.3).buckets, ...fraction(0.3).buckets.map((b) => ({ ...b, groupId: 'otro' }))] };
    const m = new QuotaMonitor([{ agentId: base.agentId, read: async () => snapshot }, { agentId: second.agentId, read: async () => second }],
      { thresholds: [0.4], intervalMs: 42, onAlert, setInterval: set, clearInterval: clear });
    monitors.push(m);
    await m.refresh(); await m.refresh();
    expect(onAlert).toHaveBeenCalledTimes(6);
    expect(m.all()).toHaveLength(2);
    expect(set).toHaveBeenCalledWith(expect.any(Function), 42);
    m.stop(); expect(clear).toHaveBeenCalledExactlyOnceWith(123);
  });

  it('ignora fracciones desconocidas y aísla errores de consumidores', async () => {
    const onAlert = vi.fn(() => { throw new Error('Consumidor'); });
    let snapshot: QuotaSnapshot = { ...base, buckets: base.buckets.map((b) => ({ ...b, remainingFraction: null })) };
    const m = monitor(async () => snapshot, { onAlert, onSnapshot: () => { throw new Error('Consumidor'); } });
    await m.refresh(); expect(onAlert).not.toHaveBeenCalled();
    snapshot = fraction(0.05);
    expect((await m.refresh(base.agentId)).error).toBeUndefined();
    expect(onAlert).toHaveBeenCalledTimes(4);
  });
});

