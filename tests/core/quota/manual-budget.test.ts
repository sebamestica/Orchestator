import { describe, expect, it } from 'vitest';
import { ManualBudgetQuota, readSpentUsd, remainingBudgetUsd } from '../../../src/core/quota/manual-budget.ts';
import { minRemainingFraction, quotaSnapshotSchema } from '../../../src/shared/index.ts';

const now = () => new Date('2026-11-01T12:00:00.000Z');

describe('ManualBudgetQuota', () => {
  it('resta lo gastado del presupuesto y lo informa en USD', async () => {
    const quota = new ManualBudgetQuota({ agentId: 'claude-main', budgetUsd: 20, spentUsd: () => 5, now });
    const snap = quotaSnapshotSchema.parse(await quota.read());
    expect(snap).toMatchObject({ agentId: 'claude-main', method: 'manual-budget', takenAt: '2026-11-01T12:00:00.000Z', stale: false });
    expect(snap.buckets).toEqual([
      {
        groupId: 'presupuesto',
        groupName: 'Presupuesto manual (USD)',
        window: 'total',
        remainingFraction: 0.75,
        remainingUnits: { amount: 15, unit: 'usd' },
      },
    ]);
    expect(minRemainingFraction(snap)).toBe(0.75);
  });

  it('acepta un gasto asíncrono y nunca informa saldo negativo', async () => {
    const quota = new ManualBudgetQuota({ agentId: 'claude-main', budgetUsd: 1, spentUsd: async () => 1.25, now });
    const snap = await quota.read();
    expect(snap.buckets[0]).toMatchObject({ remainingFraction: 0, remainingUnits: { amount: 0, unit: 'usd' } });
  });

  it('redondea a 6 decimales y respeta ventana y reinicio', async () => {
    const quota = new ManualBudgetQuota({
      agentId: 'claude-main',
      budgetUsd: 10,
      spentUsd: () => 0.1 + 0.2,
      window: 'monthly',
      resetAt: () => new Date('2026-12-01T00:00:00.000Z'),
      now,
    });
    const snap = quotaSnapshotSchema.parse(await quota.read());
    expect(snap.buckets[0]).toMatchObject({ window: 'monthly', resetAt: '2026-12-01T00:00:00.000Z', remainingUnits: { amount: 9.7 } });
  });

  it('marca la lectura como antigua si el gasto no se puede leer o es inválido', async () => {
    for (const spentUsd of [() => Number.NaN, () => -1, () => { throw new Error('sqlite cerrado'); }]) {
      const snap = quotaSnapshotSchema.parse(await new ManualBudgetQuota({ agentId: 'claude-main', budgetUsd: 5, spentUsd, now }).read());
      expect(snap.stale).toBe(true);
      expect(snap.buckets).toEqual([]);
      expect(snap.error).toMatch(/No se pudo leer el gasto/);
    }
  });

  it('rechaza presupuestos no positivos', () => {
    expect(() => new ManualBudgetQuota({ agentId: 'claude-main', budgetUsd: 0, spentUsd: () => 0 })).toThrow(/positivo/);
    expect(() => new ManualBudgetQuota({ agentId: 'claude-main', budgetUsd: Number.POSITIVE_INFINITY, spentUsd: () => 0 })).toThrow();
  });

  it('expone funciones auxiliares', async () => {
    expect(remainingBudgetUsd(3, 1)).toBe(2);
    expect(remainingBudgetUsd(3, 4)).toBe(0);
    await expect(readSpentUsd(() => 2)).resolves.toBe(2);
    await expect(readSpentUsd(() => Number.POSITIVE_INFINITY)).rejects.toThrow(/gasto inválido/);
  });
});
