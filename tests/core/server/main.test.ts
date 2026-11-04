import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startCore, defaultVault, type Core } from '../../../src/core/main.ts';
import { loadCoreConfig } from '../../../src/core/config/index.ts';
import { FileVault, MemoryVault } from '../../../src/core/vault/index.ts';
import { fakeAdapterFactory, fakeKey, fakeQuotaFactory } from './helpers.ts';

const dirs: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'orq-main-'));
  dirs.push(d);
  return d;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('tiempo agotado');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('startCore', () => {
  it('arranca con dependencias inyectadas, crea la base en la carpeta de datos y se detiene', async () => {
    const dir = await tempDir();
    const log: string[] = [];
    const core = await startCore({ env: { ORQ_DATA_DIR: dir }, config: { port: 0 }, vault: new MemoryVault(), log: (l) => log.push(l) });
    cores.push(core);
    expect(core.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(core.config.dbPath).toBe(join(dir, 'orquestador.db'));
    const res = await fetch(`${core.url}/health`, { headers: { authorization: `Bearer ${core.token}` } });
    expect(res.status).toBe(200);
    // Sin módulos inyectados, sus rutas responden 501.
    const skills = await fetch(`${core.url}/skills`, { headers: { authorization: `Bearer ${core.token}` } });
    expect(skills.status).toBe(501);
    expect(core.quotas).toBeUndefined();
    expect(await readdir(dir)).toContain('orquestador.db');
    expect(log.some((l) => l.startsWith('GET /health 200'))).toBe(true);
    expect(log.join('\n')).not.toContain(core.token);

    const other = await startCore({ env: { ORQ_DATA_DIR: dir }, config: { port: 0, dbPath: join(dir, 'otra.db') }, vault: new MemoryVault() });
    cores.push(other);
    expect(other.token).not.toBe(core.token);
    await core.stop();
    await core.stop();
    await expect(fetch(`${core.url}/health`)).rejects.toThrow();
  });

  it('lee los cupos periódicamente con la fábrica inyectada', async () => {
    const dir = await tempDir();
    const core = await startCore({
      env: { ORQ_DATA_DIR: dir },
      config: { port: 0, quotaRefreshMs: 40 },
      vault: new MemoryVault(),
      quotaProviderFactory: fakeQuotaFactory(),
    });
    cores.push(core);
    core.registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
    const quotas = await waitFor(() => (core.store.latestQuotas().length ? core.store.latestQuotas() : undefined));
    expect(quotas[0]?.snapshot.agentId).toBe('codex');
  });

  it('falla si el puerto está ocupado y no deja la base abierta', async () => {
    const dir = await tempDir();
    const first = await startCore({ env: { ORQ_DATA_DIR: dir }, config: { port: 0 }, vault: new MemoryVault() });
    cores.push(first);
    await expect(startCore({ env: { ORQ_DATA_DIR: dir }, config: { port: first.server.port, dbPath: join(dir, 'b.db') }, vault: new MemoryVault() })).rejects.toThrow(/EADDRINUSE/);
    await rm(join(dir, 'b.db'), { force: true, maxRetries: 3 });
  });

  it('defaultVault: DPAPI en Windows, en memoria (con aviso) en otros sistemas', () => {
    const config = loadCoreConfig({ env: { ORQ_DATA_DIR: 'C:\\datos' }, platform: 'win32' });
    expect(defaultVault(config, () => undefined, 'win32')).toBeInstanceOf(FileVault);
    const log: string[] = [];
    expect(defaultVault(config, (l) => log.push(l), 'linux')).toBeInstanceOf(MemoryVault);
    expect(log[0]).toMatch(/memoria/);
  });

  it.skipIf(process.platform !== 'win32')('bóveda DPAPI real de punta a punta: la clave no queda en SQLite, en vault.json ni en respuestas', async () => {
    const dir = await tempDir();
    const key = fakeKey();
    const log: string[] = [];
    const core = await startCore({ env: { ORQ_DATA_DIR: dir }, config: { port: 0 }, adapterFactory: fakeAdapterFactory(key), log: (l) => log.push(l) });
    cores.push(core);
    const auth = { authorization: `Bearer ${core.token}`, 'content-type': 'application/json' };
    const created = await fetch(`${core.url}/agents`, { method: 'POST', headers: auth, body: JSON.stringify({ provider: 'anthropic', apiKey: key, displayName: 'Claude', id: 'claude' }) });
    const createdText = await created.text();
    expect(created.status).toBe(201);
    expect(createdText).not.toContain(key);
    // La clave se recupera de la bóveda real (DPAPI) para el probe.
    const probe = await fetch(`${core.url}/agents/claude/probe`, { method: 'POST', headers: auth });
    expect(probe.status).toBe(200);
    expect(await core.vault.get((await core.vault.list())[0]?.ref ?? '')).toBe(key);
    await core.stop();

    const files = await readdir(dir);
    expect(files).toContain('vault.json');
    const b64 = Buffer.from(key).toString('base64');
    for (const f of files) {
      const bytes = await readFile(join(dir, f));
      for (const needle of [key, b64]) {
        expect(bytes.includes(Buffer.from(needle, 'utf8')), `${f} contiene la clave`).toBe(false);
        expect(bytes.includes(Buffer.from(needle, 'utf16le')), `${f} contiene la clave (utf16)`).toBe(false);
      }
    }
    expect(log.join('\n')).not.toContain(key);

    // Borrar el agente borra la clave de vault.json.
    const again = await startCore({ env: { ORQ_DATA_DIR: dir }, config: { port: 0 }, adapterFactory: fakeAdapterFactory(key) });
    cores.push(again);
    const del = await fetch(`${again.url}/agents/claude`, { method: 'DELETE', headers: { authorization: `Bearer ${again.token}` } });
    expect(del.status).toBe(200);
    const vaultFile = z.object({ entries: z.record(z.string(), z.unknown()) }).parse(JSON.parse(await readFile(join(dir, 'vault.json'), 'utf8')));
    expect(Object.keys(vaultFile.entries)).toEqual([]);
  });

  it('`node src/core/main.ts` anuncia URL y token por stdout y atiende peticiones', async () => {
    const dir = await tempDir();
    const root = resolve(import.meta.dirname, '../../..');
    const child = spawn(process.execPath, [join(root, 'src', 'core', 'main.ts')], {
      cwd: root,
      env: { ...process.env, ORQ_DATA_DIR: dir, ORQ_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    try {
      const line = await new Promise<string>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('sin línea de arranque')), 15_000);
        createInterface({ input: child.stdout }).once('line', (l) => {
          clearTimeout(timer);
          res(l);
        });
        child.once('exit', (code) => rej(new Error(`salió con ${String(code)}`)));
      });
      const ready = z.strictObject({ ready: z.literal(true), url: z.url(), wsUrl: z.string(), token: z.string().min(43) }).parse(JSON.parse(line));
      expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${ready.url}/health`, { headers: { authorization: `Bearer ${ready.token}` } });
      expect(res.status).toBe(200);
      expect((await fetch(`${ready.url}/agents`)).status).toBe(401);
    } finally {
      child.kill();
      await exited;
    }
  });
});
