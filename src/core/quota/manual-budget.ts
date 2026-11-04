import type { QuotaProvider } from '../../shared/contracts.ts';
import type { QuotaBucket, QuotaSnapshot } from '../../shared/index.ts';

/**
 * Cupo por presupuesto manual: para agentes cuyo proveedor no informa saldo (p. ej. la clave de Claude
 * del usuario, cuyo servidor no envía cabeceras). Restante = presupuesto en USD − gasto registrado.
 * El gasto lo entrega una función inyectada (normalmente una suma sobre la tabla de uso de SQLite).
 */

export type SpentUsdFn = () => Promise<number> | number;

export interface ManualBudgetOptions {
  agentId: string;
  /** Presupuesto en USD (AgentConfig.budgetUsd). */
  budgetUsd: number;
  /** Gasto acumulado en USD dentro de la ventana del presupuesto. */
  spentUsd: SpentUsdFn;
  /** Ventana que cubre `spentUsd` (por defecto `total`: desde que se fijó el presupuesto). */
  window?: QuotaBucket['window'];
  /** Momento del próximo reinicio del presupuesto, si la ventana se renueva. */
  resetAt?: () => Date | undefined;
  now?: () => Date;
}

/** Presupuesto que queda (nunca negativo). */
export function remainingBudgetUsd(budgetUsd: number, spentUsd: number): number {
  return Math.max(0, budgetUsd - spentUsd);
}

/** Lee el gasto con validación: debe ser un número finito y no negativo. */
export async function readSpentUsd(spentUsd: SpentUsdFn): Promise<number> {
  const value = await spentUsd();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`gasto inválido: ${String(value)}`);
  }
  return value;
}

export class ManualBudgetQuota implements QuotaProvider {
  readonly agentId: string;
  readonly #opts: ManualBudgetOptions;

  constructor(opts: ManualBudgetOptions) {
    if (!Number.isFinite(opts.budgetUsd) || opts.budgetUsd <= 0) {
      throw new Error('El presupuesto manual debe ser un número positivo de USD.');
    }
    this.agentId = opts.agentId;
    this.#opts = opts;
  }

  async read(): Promise<QuotaSnapshot> {
    const now = (this.#opts.now ?? (() => new Date()))();
    const base = { agentId: this.agentId, method: 'manual-budget' as const, takenAt: now.toISOString() };
    let spent: number;
    try {
      spent = await readSpentUsd(this.#opts.spentUsd);
    } catch (err) {
      return { ...base, buckets: [], stale: true, error: `No se pudo leer el gasto: ${(err as Error).message}` };
    }
    const remaining = remainingBudgetUsd(this.#opts.budgetUsd, spent);
    const bucket: QuotaBucket = {
      groupId: 'presupuesto',
      groupName: 'Presupuesto manual (USD)',
      window: this.#opts.window ?? 'total',
      remainingFraction: Math.min(1, remaining / this.#opts.budgetUsd),
      remainingUnits: { amount: round6(remaining), unit: 'usd' },
    };
    const resetAt = this.#opts.resetAt?.();
    if (resetAt) bucket.resetAt = resetAt.toISOString();
    return { ...base, buckets: [bucket], stale: false };
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
