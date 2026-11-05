/**
 * Tarifa del usuario: un multiplicador por modelo sobre el costo estimado con precios públicos. Tabla propia del
 * módulo (`CREATE TABLE IF NOT EXISTS`, sin tocar `store/schema.ts`). El multiplicador se aplica al leer, así que vale
 * para todo lo ya registrado. Un modelo sin fila vale 1.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { MAX_USAGE_MULTIPLIER, patchUsageRatesBody, redactSecrets, usageRateSchema, type UsageRate } from '../../shared/index.ts';

export const USAGE_RATES_TABLE = 'usage_stats_rates';
/** Multiplicador de un modelo sin tarifa propia (precios públicos). */
export const DEFAULT_MULTIPLIER = 1;

const rowSchema = z.object({ model: z.string(), multiplier: z.number(), updated_at: z.string() });

/** Error de una tarifa inválida (la ruta lo traduce a 400). */
export class UsageRatesError extends Error {
  override readonly name = 'UsageRatesError';
}

/** Redondeo a 4 decimales: lo que escribe una persona (1,3) y nada de ruido binario. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export class UsageRates {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, opts: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date());
    db.exec(`CREATE TABLE IF NOT EXISTS ${USAGE_RATES_TABLE} (model TEXT PRIMARY KEY, multiplier REAL NOT NULL, updated_at TEXT NOT NULL)`);
  }

  /** Tarifas guardadas, por modelo. Una fila que ya no cumple el contrato se ignora (vale 1). */
  list(): UsageRate[] {
    const out: UsageRate[] = [];
    for (const raw of this.#db.prepare(`SELECT model, multiplier, updated_at FROM ${USAGE_RATES_TABLE} ORDER BY model`).all()) {
      const row = rowSchema.safeParse(raw);
      if (!row.success) continue;
      const rate = usageRateSchema.safeParse({ model: row.data.model, multiplier: row.data.multiplier, updatedAt: row.data.updated_at });
      if (rate.success) out.push(rate.data);
    }
    return out;
  }

  /** Multiplicador de cada modelo con tarifa propia (para aplicar a muchas filas sin consultar cada vez). */
  multipliers(): Map<string, number> {
    return new Map(this.list().map((r) => [r.model, r.multiplier]));
  }

  /** Aplica un cambio (`patchUsageRatesBody`): número = nueva tarifa; `null` = vuelve a 1. Devuelve la lista. */
  apply(patch: unknown): UsageRate[] {
    const parsed = patchUsageRatesBody.safeParse(patch);
    if (!parsed.success) throw new UsageRatesError(`Tarifa inválida: ${parsed.error.issues.map((i) => i.path.join('.') || '(raíz)').join(', ')}`);
    const changes: [string, number | null][] = [];
    for (const [rawModel, value] of Object.entries(parsed.data.rates)) {
      const model = rawModel.trim();
      if (!model) throw new UsageRatesError('Tarifa inválida: modelo vacío');
      if (redactSecrets(model) !== model) throw new UsageRatesError('Tarifa inválida: un modelo con forma de clave no se puede guardar');
      if (value !== null && !(value > 0 && value <= MAX_USAGE_MULTIPLIER)) throw new UsageRatesError(`Tarifa inválida: el multiplicador va de 0 a ${MAX_USAGE_MULTIPLIER}`);
      changes.push([model, value === null ? null : round4(value)]);
    }
    const at = this.#now().toISOString();
    const upsert = this.#db.prepare(
      `INSERT INTO ${USAGE_RATES_TABLE} (model, multiplier, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET multiplier = excluded.multiplier, updated_at = excluded.updated_at`,
    );
    const remove = this.#db.prepare(`DELETE FROM ${USAGE_RATES_TABLE} WHERE model = ?`);
    this.#db.exec('BEGIN');
    try {
      for (const [model, value] of changes) {
        // Un multiplicador de 1 es lo mismo que no tener tarifa: no se guarda.
        if (value === null || value === DEFAULT_MULTIPLIER) remove.run(model);
        else upsert.run(model, value, at);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return this.list();
  }
}
