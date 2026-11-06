import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';

// Misma regla que Vitest 4 para porcentajes: redondea sobre availableParallelism y nunca baja de 1.
function resolveWorkers(value: number | string, cpus: number): number {
  if (typeof value === 'number') return value;
  const percent = Number.parseInt(value, 10);
  return Math.max(1, Math.round((cpus * percent) / 100));
}

describe('vitest.config.ts', () => {
  it('pone tope a los workers: como mucho la mitad de la CPU', () => {
    const maxWorkers = config.test?.maxWorkers;
    expect(maxWorkers).toBeDefined();
    for (const cpus of [2, 4, 8, availableParallelism()]) {
      const workers = resolveWorkers(maxWorkers ?? Number.NaN, cpus);
      expect(Number.isInteger(workers)).toBe(true);
      expect(workers).toBeGreaterThanOrEqual(1);
      expect(workers).toBeLessThanOrEqual(Math.max(1, Math.ceil(cpus / 2)));
    }
  });
});
