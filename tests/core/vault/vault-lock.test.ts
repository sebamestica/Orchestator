import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileVault, VaultError, type Cipher } from '../../../src/core/vault/index.ts';

/** Cifrado de prueba lento: obliga a que las operaciones de dos instancias se intercalen. */
const slowCipher: Cipher = {
  async protect(plain) {
    await new Promise((r) => setTimeout(r, 15));
    return Buffer.from(plain, 'utf8').toString('base64');
  },
  async unprotect(b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
  },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-vault-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function refsOnDisk(path: string): Promise<string[]> {
  const data = JSON.parse(await readFile(path, 'utf8')) as { entries: Record<string, unknown> };
  return Object.keys(data.entries).sort();
}

// Revisión de seguridad 2026-11-01 (Codex), hallazgo 5.
describe('revisión: candado entre instancias de la bóveda (hallazgo 5)', () => {
  it('dos instancias sobre el mismo vault.json no pierden escrituras', async () => {
    const path = join(dir, 'vault.json');
    const a = new FileVault({ path, cipher: slowCipher });
    const b = new FileVault({ path, cipher: slowCipher });
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      ops.push(a.set(`a-${i}`, `valor-a-${i}`), b.set(`b-${i}`, `valor-b-${i}`));
    }
    await Promise.all(ops);
    const expected = Array.from({ length: 8 }, (_, i) => [`a-${i}`, `b-${i}`]).flat().sort();
    expect(await refsOnDisk(path)).toEqual(expected);
    await Promise.all([a.delete('a-0'), b.delete('b-0'), a.set('c-1', 'x'), b.set('c-2', 'y')]);
    expect(await refsOnDisk(path)).toEqual([...expected.filter((r) => r !== 'a-0' && r !== 'b-0'), 'c-1', 'c-2'].sort());
    expect(await b.get('a-3')).toBe('valor-a-3');
  });

  it('dos procesos de Node sobre el mismo vault.json no pierden escrituras', async () => {
    const path = join(dir, 'vault.json');
    const root = resolve(import.meta.dirname, '../../..');
    const script = join(dir, 'escritor.ts');
    const vaultModule = join(root, 'src', 'core', 'vault', 'index.ts').replaceAll('\\', '/');
    writeFileSync(
      script,
      [
        `import { FileVault } from 'file:///${vaultModule.replace(/^\//, '')}';`,
        `const cipher = { protect: async (p) => { await new Promise((r) => setTimeout(r, 10)); return Buffer.from(p).toString('base64'); }, unprotect: async (b) => Buffer.from(b, 'base64').toString() };`,
        `const v = new FileVault({ path: process.argv[2], cipher });`,
        `const tag = process.argv[3];`,
        `await Promise.all(Array.from({ length: 10 }, (_, i) => v.set(tag + '-' + i, 'valor-' + i)));`,
      ].join('\n'),
    );
    const run = (tag: string) =>
      new Promise<number | null>((res, rej) => {
        const child = spawn(process.execPath, [script, path, tag], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.once('error', rej);
        child.once('exit', (code) => (code === 0 ? res(code) : rej(new Error(`salió con ${String(code)}: ${err.slice(-500)}`))));
      });
    await Promise.all([run('p1'), run('p2')]);
    const expected = ['p1', 'p2'].flatMap((t) => Array.from({ length: 10 }, (_, i) => `${t}-${i}`)).sort();
    expect(await refsOnDisk(path)).toEqual(expected);
  });

  it('libera un candado abandonado por un proceso que ya no existe', async () => {
    const path = join(dir, 'vault.json');
    mkdirSync(`${path}.lock`);
    // pid improbable en este equipo: el dueño «murió» sin liberar.
    writeFileSync(join(`${path}.lock`, 'owner'), JSON.stringify({ pid: 2_147_483_000, host: hostname(), at: new Date().toISOString(), token: 'viejo' }));
    const v = new FileVault({ path, cipher: slowCipher, lock: { timeoutMs: 2000 } });
    await v.set('k1', 'valor');
    expect(await refsOnDisk(path)).toEqual(['k1']);
  });

  it('respeta un candado vigente de otro proceso y falla con VaultError al agotar la espera', async () => {
    const path = join(dir, 'vault.json');
    mkdirSync(`${path}.lock`);
    writeFileSync(join(`${path}.lock`, 'owner'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: 'otro' }));
    const v = new FileVault({ path, cipher: slowCipher, lock: { timeoutMs: 300, retryMs: 20 } });
    const err = await v.set('k1', 'valor-secreto-123').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VaultError);
    expect((err as Error).message).toMatch(/ocupada/);
    expect((err as Error).message).not.toContain('valor-secreto-123');
  });
});
