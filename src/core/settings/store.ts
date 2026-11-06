import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DEFAULT_SETTINGS, settingsPatchSchema, settingsSchema, type Settings, type SettingsPatch } from '../../shared/index.ts';
import { redactDeep, StoreError } from '../store/index.ts';

/** Tabla propia del módulo (F5: sin tocar `schema.ts`). Una fila por clave de primer nivel de `Settings`. */
export const SETTINGS_TABLE = 'settings_kv';

type SettingsKey = keyof Settings;
const KEYS = Object.keys(settingsSchema.shape) as SettingsKey[];
const rowSchema = z.object({ key: z.string(), value: z.string() });

export type SettingsListener = (settings: Settings) => void;

export interface SettingsStoreOptions {
  now?: () => Date;
  /** Fila guardada que ya no cumple el contrato (se usa el valor por defecto de esa clave). */
  onInvalidRow?: (key: string) => void;
}

function fieldsOf(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.') || '(raíz)').join(', ');
}

/** Aplica un cambio parcial de un nivel de profundidad. `mind.model: null` borra el modelo. */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = structuredClone(current);
  if (patch.mind) {
    const m = patch.mind;
    if (m.agentId !== undefined) next.mind.agentId = m.agentId;
    if (m.effort !== undefined) next.mind.effort = m.effort;
    if (m.model === null) delete next.mind.model;
    else if (m.model !== undefined) next.mind.model = m.model;
  }
  if (patch.mindLimits) {
    const l = patch.mindLimits;
    if (l.turnUsd !== undefined) next.mindLimits.turnUsd = l.turnUsd;
    if (l.dayUsd !== undefined) next.mindLimits.dayUsd = l.dayUsd;
    if (l.maxAutonomousTurns !== undefined) next.mindLimits.maxAutonomousTurns = l.maxAutonomousTurns;
  }
  if (patch.workers !== undefined) next.workers = [...new Set(patch.workers)];
  if (patch.defaultMode !== undefined) next.defaultMode = patch.defaultMode;
  if (patch.quotaFloor !== undefined) next.quotaFloor = patch.quotaFloor;
  if (patch.concurrency !== undefined) next.concurrency = patch.concurrency;
  if (patch.appearance) {
    const a = patch.appearance;
    if (a.theme !== undefined) next.appearance.theme = a.theme;
    if (a.reducedEffects !== undefined) next.appearance.reducedEffects = a.reducedEffects;
  }
  return next;
}

/**
 * Ajustes de la interfaz (GET/PATCH /settings) en SQLite. Se leen una vez y quedan en memoria; cada `get()` devuelve
 * una copia. Lo guardado se valida con `settingsSchema` al leer (dato externo): una clave inválida vuelve a su valor
 * por defecto sin romper las demás.
 */
export class SettingsStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #onInvalidRow: (key: string) => void;
  readonly #listeners = new Set<SettingsListener>();
  #cache: Settings | undefined;

  constructor(db: DatabaseSync, opts: SettingsStoreOptions = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date());
    this.#onInvalidRow = opts.onInvalidRow ?? (() => undefined);
    db.exec(`CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  get(): Settings {
    this.#cache ??= this.#read();
    return structuredClone(this.#cache);
  }

  /**
   * Valida el cambio (`settingsPatchSchema`), lo aplica y guarda las claves que cambiaron. Avisa a los oyentes solo si
   * algo cambió. Lanza `StoreError('invalid')` (400) si el cambio o el resultado no cumplen el contrato.
   */
  update(patch: unknown): Settings {
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new StoreError('invalid', `Ajustes inválidos: ${fieldsOf(parsed.error)}`);
    const current = this.get();
    const merged = settingsSchema.safeParse(applySettingsPatch(current, parsed.data));
    if (!merged.success) throw new StoreError('invalid', `Ajustes inválidos: ${fieldsOf(merged.error)}`);
    const next = merged.data;
    if (JSON.stringify(redactDeep(next)) !== JSON.stringify(next)) {
      throw new StoreError('invalid', 'Ajustes: un campo con forma de clave no se puede guardar');
    }
    const changed = KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    if (changed.length > 0) {
      const at = this.#now().toISOString();
      const upsert = this.#db.prepare(
        `INSERT INTO ${SETTINGS_TABLE} (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      this.#db.exec('BEGIN');
      try {
        for (const k of changed) upsert.run(k, JSON.stringify(next[k]), at);
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
      this.#cache = next;
      for (const listener of [...this.#listeners]) {
        try {
          listener(structuredClone(next));
        } catch {
          /* un oyente nunca rompe el guardado */
        }
      }
    }
    return structuredClone(next);
  }

  /** Avisa cada vez que los ajustes cambian (después de guardarlos). */
  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #read(): Settings {
    const out: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS);
    const rows = this.#db.prepare(`SELECT key, value FROM ${SETTINGS_TABLE}`).all();
    for (const raw of rows) {
      const row = rowSchema.safeParse(raw);
      if (!row.success) continue;
      const key = KEYS.find((k) => k === row.data.key);
      if (!key) continue;
      let value: unknown;
      try {
        value = JSON.parse(row.data.value);
      } catch {
        this.#onInvalidRow(row.data.key);
        continue;
      }
      const field = settingsSchema.shape[key].safeParse(value);
      if (field.success) out[key] = field.data;
      else this.#onInvalidRow(row.data.key);
    }
    return settingsSchema.parse(out);
  }
}

const shared = new WeakMap<DatabaseSync, SettingsStore>();

/**
 * La instancia de `SettingsStore` de una base (una sola por base: así la caché y los oyentes son los mismos para
 * c14, c15 y c16). Las opciones solo cuentan la primera vez.
 */
export function settingsStoreFor(db: DatabaseSync, opts: SettingsStoreOptions = {}): SettingsStore {
  let store = shared.get(db);
  if (!store) {
    store = new SettingsStore(db, opts);
    shared.set(db, store);
  }
  return store;
}
