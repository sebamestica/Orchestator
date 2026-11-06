import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MIGRATIONS, QUOTA_KEEP_PER_AGENT } from '../../../src/core/store/schema.ts';
import type { QuotaSnapshot } from '../../../src/shared/index.ts';

const open: SqliteStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function snap(agentId: string, i: number): QuotaSnapshot {
  return { agentId, method: 'agy-usage', takenAt: new Date(Date.UTC(2026, 10, 1) + i * 300_000).toISOString(), stale: false, buckets: [] };
}

const countOf = (store: SqliteStore, agentId: string) =>
  Number(store.database.prepare('SELECT COUNT(*) AS n FROM quota_snapshots WHERE agent_id = ?').get(agentId)?.n);

describe('fotos de cupo: retención por agente', () => {
  it('recordQuota conserva solo las últimas fotos de cada agente', () => {
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    open.push(store);
    for (let i = 0; i < 1000; i++) store.recordQuota(snap('agy', i));
    for (let i = 0; i < 10; i++) store.recordQuota(snap('codex', i));

    expect(countOf(store, 'agy')).toBe(QUOTA_KEEP_PER_AGENT);
    expect(countOf(store, 'codex')).toBe(10);
    expect(store.latestQuotas().map((q) => q.snapshot)).toEqual([snap('agy', 999), snap('codex', 9)]);
    expect(store.quotaHistory('agy', 1000).at(-1)?.snapshot).toEqual(snap('agy', 1000 - QUOTA_KEEP_PER_AGENT));
  });

  it('al abrir una base con historial acumulado lo recorta sin cambiar la última foto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orq-quota-keep-'));
    dirs.push(dir);
    const path = join(dir, 'orquestador.db');
    const version = MIGRATIONS.length - 1;
    const raw = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, version)) raw.exec(sql);
    raw.exec(`PRAGMA user_version = ${version}`);
    const insert = raw.prepare(
      'INSERT INTO quota_snapshots (agent_id, method, taken_at, stale, error, snapshot_json, recorded_at) VALUES (?, ?, ?, 0, NULL, ?, ?)',
    );
    const rows = [...Array.from({ length: 1000 }, (_, i) => snap('agy', i)), ...Array.from({ length: 5 }, (_, i) => snap('codex', i))];
    raw.exec('BEGIN');
    for (const s of rows) insert.run(s.agentId, s.method, s.takenAt, JSON.stringify(s), s.takenAt);
    raw.exec('COMMIT');
    raw.close();

    const store = new SqliteStore({ path, timeZone: 'UTC' });
    open.push(store);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(countOf(store, 'agy')).toBe(QUOTA_KEEP_PER_AGENT);
    expect(countOf(store, 'codex')).toBe(5);
    expect(store.latestQuotas().map((q) => q.snapshot)).toEqual([snap('agy', 999), snap('codex', 4)]);
  });
});
