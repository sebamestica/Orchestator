import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDpapiCipher,
  dpapiArgs,
  FileVault,
  MemoryVault,
  VaultError,
  type Cipher,
  type SpawnFn,
} from '../../../src/core/vault/index.ts';

/** Clave falsa generada en tiempo de ejecución (nunca una real). */
function fakeKey(): string {
  return `sk-ant-test-${randomBytes(16).toString('hex')}`;
}

/** Cifrado reversible de prueba (XOR + base64): el texto plano no aparece en el archivo. */
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

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('Se esperaba un rechazo');
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-vault-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('FileVault (cifrado de prueba)', () => {
  it('set/get/delete/list y list devuelve solo referencias', async () => {
    const path = join(dir, 'nested', 'vault.json');
    const logs: string[] = [];
    const vault = new FileVault({ path, cipher: xorCipher, log: (l) => logs.push(l), now: () => new Date('2026-11-01T12:00:00.000Z') });
    const secret = fakeKey();
    const other = fakeKey();

    const info = await vault.set('claude-key', secret, { label: 'Claude (clave del usuario)' });
    expect(info).toEqual({ ref: 'claude-key', label: 'Claude (clave del usuario)', createdAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-11-01T12:00:00.000Z' });
    await vault.set('openrouter-key', other);

    expect(await vault.get('claude-key')).toBe(secret);
    expect(await vault.get('openrouter-key')).toBe(other);
    expect(await vault.get('no-existe')).toBeUndefined();

    const list = await vault.list();
    expect(list.map((e) => e.ref)).toEqual(['claude-key', 'openrouter-key']);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['createdAt', 'ref', 'updatedAt']));
      for (const k of Object.keys(entry)) expect(['ref', 'label', 'createdAt', 'updatedAt']).toContain(k);
    }
    const listText = JSON.stringify(list);
    expect(listText).not.toContain(secret);
    expect(listText).not.toContain(other);
    expect(listText).not.toContain('protected');

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(other);
    expect(raw).not.toContain(Buffer.from(secret).toString('base64'));
    expect(JSON.parse(raw)).toMatchObject({ version: 1, scheme: 'dpapi-currentuser' });

    expect(await vault.delete('claude-key')).toBe(true);
    expect(await vault.delete('claude-key')).toBe(false);
    expect(await vault.get('claude-key')).toBeUndefined();
    expect((await vault.list()).map((e) => e.ref)).toEqual(['openrouter-key']);

    // Solo quedan los temporales renombrados: ningún .tmp suelto.
    expect((await readdir(join(dir, 'nested'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    expect(logs).toEqual(['vault set claude-key', 'vault set openrouter-key', 'vault get claude-key', 'vault get openrouter-key', 'vault delete claude-key']);
    for (const line of logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain(other);
    }
  });

  it('actualizar conserva createdAt y la etiqueta anterior', async () => {
    let clock = Date.parse('2026-11-01T12:00:00.000Z');
    const vault = new FileVault({ path: join(dir, 'vault.json'), cipher: xorCipher, now: () => new Date(clock) });
    await vault.set('k1', 'valor-uno', { label: 'Etiqueta' });
    clock += 60_000;
    const updated = await vault.set('k1', 'valor-dos');
    expect(updated).toEqual({ ref: 'k1', label: 'Etiqueta', createdAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-11-01T12:01:00.000Z' });
    expect(await vault.get('k1')).toBe('valor-dos');
  });

  it('rechaza referencias inválidas y valores vacíos o demasiado largos', async () => {
    const vault = new FileVault({ path: join(dir, 'vault.json'), cipher: xorCipher });
    const secret = fakeKey();
    for (const ref of ['', 'A', 'Mayus', '../escape', 'con espacio', 'x'.repeat(65)]) {
      const err = await rejection(vault.set(ref, secret));
      expect(err).toBeInstanceOf(VaultError);
      expect(err.message).not.toContain(secret);
    }
    await expect(vault.get('../x')).rejects.toBeInstanceOf(VaultError);
    await expect(vault.delete('../x')).rejects.toBeInstanceOf(VaultError);
    await expect(vault.set('k1', '')).rejects.toBeInstanceOf(VaultError);
    const long = 'a'.repeat(16_385);
    const err = await rejection(vault.set('k1', long));
    expect(err).toBeInstanceOf(VaultError);
    expect(err.message).not.toContain(long);
    await expect(vault.set('k1', 'valor-ok', { label: '' })).rejects.toBeInstanceOf(VaultError);
    await expect(vault.set('k1', 'valor-ok', { label: 'e'.repeat(121) })).rejects.toBeInstanceOf(VaultError);
    expect(await vault.list()).toEqual([]);
  });

  it('un archivo dañado da VaultError sin repetir su contenido', async () => {
    const path = join(dir, 'vault.json');
    const leaked = fakeKey();
    writeFileSync(path, `no es json ${leaked}`);
    const vault = new FileVault({ path, cipher: xorCipher });
    const err = await rejection(vault.list());
    expect(err).toBeInstanceOf(VaultError);
    expect(err.message).not.toContain(leaked);

    writeFileSync(path, JSON.stringify({ version: 1, scheme: 'dpapi-currentuser', entries: { k1: { protected: leaked, createdAt: 'x', updatedAt: 'y' } } }));
    const err2 = await rejection(vault.get('k1'));
    expect(err2).toBeInstanceOf(VaultError);
    expect(err2.message).not.toContain(leaked);
  });

  it('serializa escrituras concurrentes sin perder ninguna', async () => {
    const path = join(dir, 'vault.json');
    const vault = new FileVault({ path, cipher: xorCipher });
    const values = Array.from({ length: 10 }, () => fakeKey());
    await Promise.all(values.map((v, i) => vault.set(`k-${i}`, v)));
    const list = await vault.list();
    expect(list).toHaveLength(10);
    for (const [i, v] of values.entries()) expect(await vault.get(`k-${i}`)).toBe(v);
    // Otra instancia sobre el mismo archivo ve lo mismo.
    expect(await new FileVault({ path, cipher: xorCipher }).list()).toHaveLength(10);
  });

  it('un error del cifrado no deja escrito nada', async () => {
    const path = join(dir, 'vault.json');
    const failing: Cipher = {
      protect: () => Promise.reject(new VaultError('DPAPI (protect) falló')),
      unprotect: xorCipher.unprotect,
    };
    const vault = new FileVault({ path, cipher: failing });
    await expect(vault.set('k1', fakeKey())).rejects.toBeInstanceOf(VaultError);
    // La cola sigue funcionando después de un fallo.
    expect(await vault.list()).toEqual([]);
  });
});

describe('MemoryVault', () => {
  it('set/get/delete/list sin exponer valores en list', async () => {
    const vault = new MemoryVault();
    const secret = fakeKey();
    await vault.set('b-key', secret, { label: 'B' });
    await vault.set('a-key', 'otro-valor');
    expect(await vault.get('b-key')).toBe(secret);
    const list = await vault.list();
    expect(list.map((e) => e.ref)).toEqual(['a-key', 'b-key']);
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list[1]?.label).toBe('B');
    expect(await vault.delete('b-key')).toBe(true);
    expect(await vault.get('b-key')).toBeUndefined();
    await expect(vault.set('Mal', 'x')).rejects.toBeInstanceOf(VaultError);
    await expect(vault.set('ok-ref', '')).rejects.toBeInstanceOf(VaultError);
  });
});

describe.skipIf(process.platform !== 'win32')('DPAPI real (Windows)', () => {
  it('cifra y descifra texto no ASCII', { timeout: 60_000 }, async () => {
    const cipher = createDpapiCipher();
    const plain = `${fakeKey()}-ñandú-🔑`;
    const protectedB64 = await cipher.protect(plain);
    expect(protectedB64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(protectedB64).not.toContain(Buffer.from(plain).toString('base64'));
    expect(await cipher.unprotect(protectedB64)).toBe(plain);
  });

  it('FileVault con DPAPI: el secreto no aparece en argv, en el archivo ni en los registros', { timeout: 60_000 }, async () => {
    const calls: { command: string; args: string[] }[] = [];
    const recordingSpawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args: [...args] });
      return nodeSpawn(command, [...args], options);
    };
    const logs: string[] = [];
    const path = join(dir, 'vault.json');
    const vault = new FileVault({ path, cipher: createDpapiCipher({ spawn: recordingSpawn }), log: (l) => logs.push(l) });
    const secret = fakeKey();
    const secretB64 = Buffer.from(secret, 'utf8').toString('base64');

    await vault.set('claude-key', secret, { label: 'Claude' });
    expect(await vault.get('claude-key')).toBe(secret);
    expect((await vault.list()).map((e) => e.ref)).toEqual(['claude-key']);

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(secretB64);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe('powershell.exe');
      expect(call.args).toEqual(dpapiArgs());
      const argv = [call.command, ...call.args].join(' ');
      expect(argv).not.toContain(secret);
      expect(argv).not.toContain(secretB64);
      // El script codificado tampoco contiene el valor.
      const script = Buffer.from(call.args.at(-1) ?? '', 'base64').toString('utf16le');
      expect(script).not.toContain(secret);
      expect(script).toContain('ProtectedData');
    }

    expect(await vault.delete('claude-key')).toBe(true);
    expect(await vault.get('claude-key')).toBeUndefined();
    expect(readFileSync(path, 'utf8')).not.toContain('claude-key');

    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const line of logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain(secretB64);
    }
  });

  it('descifrar basura falla con VaultError sin repetir la entrada', { timeout: 60_000 }, async () => {
    const cipher = createDpapiCipher();
    const garbage = Buffer.from(`basura-no-cifrada-${randomBytes(8).toString('hex')}`).toString('base64');
    const err = await rejection(cipher.unprotect(garbage));
    expect(err).toBeInstanceOf(VaultError);
    expect(err.message).toMatch(/DPAPI \(unprotect\)/);
    expect(err.message).not.toContain(garbage);
    // Formato inválido: se rechaza antes de lanzar PowerShell.
    const bad = await rejection(cipher.unprotect('no es base64!'));
    expect(bad).toBeInstanceOf(VaultError);
    expect(bad.message).not.toContain('no es base64!');
  });
});
