import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type * as Fs from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileVault, VaultError, type Cipher } from '../../../src/core/vault/index.ts';

/** `rename` que falla con EPERM las veces pedidas (como cuando Defender tiene el archivo abierto) y luego delega al real. */
const fsState = vi.hoisted(() => ({ renameFailures: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (fsState.renameFailures > 0) {
        fsState.renameFailures--;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return actual.rename(from, to);
    }),
    writeFile: vi.fn(actual.writeFile),
  };
});

/** Cifrado reversible de prueba (XOR + base64), el mismo de `vault.test.ts`. */
const xorCipher: Cipher = {
  async protect(plain) {
    const b = Buffer.from(plain, 'utf8');
    for (let i = 0; i < b.length; i++) b[i] = (b[i] ?? 0) ^ 0x5a;
    return b.toString('base64');
  },
  async unprotect(b64) {
    const b = Buffer.from(b64, 'base64');
    for (let i = 0; i < b.length; i++) b[i] = (b[i] ?? 0) ^ 0x5a;
    return b.toString('utf8');
  },
};

function fakeKey(): string {
  return `sk-ant-test-${randomBytes(16).toString('hex')}`;
}

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-vault-dur-'));
  path = join(dir, 'vault.json');
  fsState.renameFailures = 0;
  vi.mocked(writeFile).mockClear();
});
afterEach(async () => {
  fsState.renameFailures = 0;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('FileVault: durabilidad de la escritura', () => {
  it('reintenta el rename ante EPERM y no deja temporales', async () => {
    const vault = new FileVault({ path, cipher: xorCipher });
    fsState.renameFailures = 2;
    await vault.set('k1', 'v');
    expect(fsState.renameFailures).toBe(0);
    expect(await vault.get('k1')).toBe('v');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('escribe el temporal con flush antes de reemplazar', async () => {
    const vault = new FileVault({ path, cipher: xorCipher });
    await vault.set('k1', 'v');
    const tmpCall = vi.mocked(writeFile).mock.calls.find(([target]) => String(target).endsWith('.tmp'));
    expect(tmpCall).toBeDefined();
    expect(tmpCall?.[2]).toMatchObject({ flush: true });
  });

  it('si vault.json queda lleno de NUL, lee desde la copia', async () => {
    const logs: string[] = [];
    const vault = new FileVault({ path, cipher: xorCipher, log: (l) => logs.push(l) });
    await vault.set('k1', 'v1');
    await vault.set('k2', 'v2');
    expect(existsSync(`${path}.bak`)).toBe(true);
    writeFileSync(path, Buffer.alloc(200));
    expect(await vault.get('k1')).toBe('v1');
    expect(logs.some((l) => l.includes('recuperada desde la copia'))).toBe(true);
  });

  it('una escritura tras recuperar no pisa la copia buena con el archivo dañado', async () => {
    const vault = new FileVault({ path, cipher: xorCipher });
    await vault.set('k1', 'v1');
    await vault.set('k2', 'v2');
    writeFileSync(path, Buffer.alloc(200));
    await vault.set('k3', 'v3');
    expect((await vault.list()).map((e) => e.ref)).toEqual(['k1', 'k3']);
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).entries).toHaveProperty('k1');
  });

  it('daño sin copia: set aparta el archivo dañado y empieza una bóveda vacía', async () => {
    const original = Buffer.alloc(200);
    writeFileSync(path, original);
    const logs: string[] = [];
    const vault = new FileVault({ path, cipher: xorCipher, log: (l) => logs.push(l) });
    await expect(vault.list()).rejects.toBeInstanceOf(VaultError);
    await vault.set('kx', fakeKey());
    const apartados = readdirSync(dir).filter((f) => f.startsWith('vault.json.danada-'));
    expect(apartados).toHaveLength(1);
    expect(readFileSync(join(dir, apartados[0] ?? '')).equals(original)).toBe(true);
    expect((await vault.list()).map((e) => e.ref)).toEqual(['kx']);
    expect(logs.some((l) => l.includes('vault.json.danada-'))).toBe(true);
  });

  it('una versión desconocida no se trata como daño ni se mueve', async () => {
    const content = `${JSON.stringify({ version: 2, scheme: 'dpapi-currentuser', entries: {} })}\n`;
    writeFileSync(path, content);
    const vault = new FileVault({ path, cipher: xorCipher });
    await expect(vault.set('k1', 'v')).rejects.toBeInstanceOf(VaultError);
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(readdirSync(dir).filter((f) => f !== 'vault.json')).toEqual([]);
  });
});
