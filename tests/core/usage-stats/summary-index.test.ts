import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MIGRATIONS } from '../../../src/core/store/schema.ts';
import { USAGE_RANGE_SQL } from '../../../src/core/usage-stats/index.ts';

const open: SqliteStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function planOf(db: DatabaseSync, sql: string): string[] {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all('2026-11-01', '2026-11-05')
    .map((row) => String(row.detail));
}

describe('uso por rango de días: índice usage_day', () => {
  it('el resumen de uso busca por día en el índice en vez de recorrer toda la tabla', () => {
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    open.push(store);
    const plan = planOf(store.database, USAGE_RANGE_SQL);
    expect(plan.some((d) => d.startsWith('SEARCH u USING INDEX usage_day')), plan.join('\n')).toBe(true);
    expect(plan.some((d) => d.startsWith('SCAN u')), plan.join('\n')).toBe(false);
  });

  it('los totales con rango y sin agente (GET /usage?from&to) también usan el índice', () => {
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    open.push(store);
    const plan = planOf(store.database, 'SELECT SUM(input_tokens) FROM usage WHERE day >= ? AND day <= ?');
    expect(plan.some((d) => d.includes('USING INDEX usage_day')), plan.join('\n')).toBe(true);
  });

  it('una base en el esquema v3 recibe el índice al abrirse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orq-usage-day-'));
    dirs.push(dir);
    const path = join(dir, 'orquestador.db');
    const raw = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, 3)) raw.exec(sql);
    raw.exec('PRAGMA user_version = 3');
    raw.close();

    const store = new SqliteStore({ path, timeZone: 'UTC' });
    open.push(store);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    const index = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'usage_day'").get();
    expect(index?.name).toBe('usage_day');
  });
});
