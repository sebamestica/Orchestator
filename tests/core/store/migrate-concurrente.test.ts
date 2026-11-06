import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore, StoreError } from '../../../src/core/store/index.ts';
import { MIGRATIONS } from '../../../src/core/store/schema.ts';

const storeUrl = pathToFileURL(resolve(import.meta.dirname, '../../../src/core/store/index.ts')).href;

// Proceso hijo: avisa «ready» justo antes de abrir el almacén (que migra en el constructor) e informa el resultado.
const CHILD = `
import { SqliteStore } from ${JSON.stringify(storeUrl)};
process.stdout.write('ready\\n');
try {
  const s = new SqliteStore({ path: process.env.ORQ_TEST_DB });
  process.stdout.write('version ' + s.schemaVersion() + '\\n');
  s.close();
} catch (err) {
  process.stdout.write('error ' + (err instanceof Error ? err.message : String(err)) + '\\n');
  process.exitCode = 1;
}
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-migrate-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SqliteStore.migrate entre procesos', () => {
  it('no repite una migración que otro proceso aplicó mientras esperaba el candado', async () => {
    const path = join(dir, 'orquestador.db');
    // «A» toma el candado de escritura y migra la base nueva, pero aún no confirma.
    const a = new DatabaseSync(path);
    a.exec('PRAGMA journal_mode = WAL;');
    a.exec('BEGIN IMMEDIATE');
    for (const sql of MIGRATIONS) a.exec(sql);
    a.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    // «B» (otro proceso) abre el almacén: lee la versión confirmada (0) y queda esperando el candado.
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { ...process.env, ORQ_TEST_DB: path },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      for (let i = 0; i < 300 && !out.includes('ready'); i++) await sleep(50);
      expect(out, err).toContain('ready');
      await sleep(500);
      a.exec('COMMIT');
    } finally {
      if (a.isTransaction) a.exec('ROLLBACK');
      a.close();
    }

    const code = await exited;
    expect(out, err).toContain(`version ${MIGRATIONS.length}`);
    expect(code).toBe(0);
  }, 30_000);

  it('rechaza con un error claro una base de un esquema más nuevo que el código', () => {
    const path = join(dir, 'orquestador.db');
    new SqliteStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    let caught: unknown;
    try {
      new SqliteStore({ path }).close();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StoreError);
    expect((caught as StoreError).message).toMatch(/v99.*más nueva/);
  });
});
