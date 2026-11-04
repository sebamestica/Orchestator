import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultLockBusyError, withVaultLock } from '../../../src/core/memory/vault-lock.ts';

let dir: string;
let lock: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orq-vault-lock-mem-'));
  lock = path.join(dir, '.candado');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function plant(pid: number, token: string): Promise<void> {
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner'), JSON.stringify({ pid, host: hostname(), at: new Date().toISOString(), token }));
}

const ownerToken = async () => (JSON.parse(await readFile(path.join(lock, 'owner'), 'utf8')) as { token: string }).token;

describe('withVaultLock', () => {
  it('excluye a los que esperan dentro del mismo proceso y no deja restos', async () => {
    let inside = 0;
    let max = 0;
    await Promise.all(Array.from({ length: 6 }, () => withVaultLock(lock, async () => {
      inside++;
      max = Math.max(max, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
    })));
    expect(max).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('rompe el candado de un proceso muerto en este equipo', async () => {
    await plant(4242, 'muerto');
    const result = await withVaultLock(lock, async () => 'hecho', { timeoutMs: 2000, isAlive: (pid) => pid !== 4242 });
    expect(result).toBe('hecho');
    expect(await readdir(dir)).toEqual([]);
  });

  it('no rompe un candado vivo: espera y falla con VaultLockBusyError', async () => {
    await plant(process.pid, 'vivo');
    await expect(withVaultLock(lock, async () => 'nunca', { timeoutMs: 150 })).rejects.toThrow(VaultLockBusyError);
    expect(await ownerToken()).toBe('vivo');
  });

  it('si el candado cambió de manos entre leer al dueño y comprobar su pid, no lo toca', async () => {
    // Intercalado que con file-lock.ts de c5 deja un instante sin candado: el que espera leyó al dueño A;
    // justo entonces A suelta el candado y termina, y C (vivo) lo toma. La comprobación del pid de A da
    // «muerto», pero el candado ya es de C y no se debe mover ni borrar.
    await plant(1111, 'A');
    let handedOver = false;
    const isAlive = (pid: number) => {
      if (pid === 1111 && !handedOver) {
        handedOver = true;
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: 2222, host: hostname(), at: new Date().toISOString(), token: 'C' }));
      }
      return pid !== 1111;
    };
    await expect(withVaultLock(lock, async () => 'nunca', { timeoutMs: 200, isAlive })).rejects.toThrow(VaultLockBusyError);
    expect(handedOver).toBe(true);
    expect(await ownerToken()).toBe('C');
    expect(await readdir(dir)).toEqual(['.candado']);
  });

  it('un candado sin dueño legible solo se rompe por antigüedad', async () => {
    await mkdir(lock);
    await expect(withVaultLock(lock, async () => 'nunca', { timeoutMs: 150, staleMs: 60_000 })).rejects.toThrow(VaultLockBusyError);
    expect(existsSync(lock)).toBe(true);
    const result = await withVaultLock(lock, async () => 'hecho', { timeoutMs: 2000, staleMs: 0 });
    expect(result).toBe('hecho');
    expect(await readdir(dir)).toEqual([]);
  });
});
