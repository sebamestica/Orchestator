// Hallazgo 2 de la revisión de agy (ALTA): release comparaba solo agente + tarea, que salen en los errores busy.
// Cualquiera podía liberar un candado ajeno, y un reintento de la misma tarea liberaba el de la ejecución nueva.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockError, LockManager, OWNER_FILE } from '../../../src/core/locks/index.ts';
import { c7, codex, lockError, settle, useTmpRoot } from './helpers.ts';

const tmp = useTmpRoot();
type Proof = Parameters<LockManager['release']>[1];

describe('liberación con token (hallazgo 2)', () => {
  it('conocer agente y tarea por el error busy no basta para liberar un candado ajeno', async () => {
    const locks = new LockManager({ root: tmp.root });
    await locks.acquire('gpu', c7);
    const busy = await lockError(locks.acquire('gpu', codex));
    const copied = { agent: busy.holder?.agent, task: busy.holder?.task };
    const outcome = await settle(locks.release('gpu', copied as unknown as Proof));
    expect(outcome).toBeInstanceOf(LockError);
    expect((await locks.read('gpu'))?.holder.agent).toBe('c7');
    // La liberación de mantenimiento (solo para candados en texto de la skill) tampoco lo toca.
    expect((await lockError(locks.releaseSkillLock('gpu', c7))).code).toBe('not_owner');
    expect((await locks.read('gpu'))?.holder.agent).toBe('c7');
  });

  it('una liberación tardía de la ejecución anterior no libera el candado de la ejecución nueva de la misma tarea', async () => {
    const locks = new LockManager({ root: tmp.root });
    const first = await locks.acquire('gpu', c7);
    await first.release();
    const second = await locks.acquire('gpu', c7);
    expect(await settle(first.release())).toMatchObject({ code: 'not_owner' });
    expect(await locks.read('gpu')).toBeDefined();
    await second.release();
    expect(await locks.read('gpu')).toBeUndefined();
  });

  it('el token no sale en errores, listados ni en el archivo owner, que guarda solo su hash', async () => {
    const locks = new LockManager({ root: tmp.root });
    const handle = await locks.acquire('gpu', c7);
    expect(handle.token).toMatch(/^[0-9a-f]{32}$/);
    const busy = await lockError(locks.acquire('gpu', codex));
    const file = await readFile(join(tmp.root, 'gpu', OWNER_FILE), 'utf8');
    for (const text of [busy.message, JSON.stringify(busy.holder), JSON.stringify(await locks.list()), JSON.stringify(handle.owner), file]) {
      expect(text).not.toContain(handle.token);
    }
    expect(JSON.parse(file).tokenHash).toBe(createHash('sha256').update(handle.token).digest('hex'));
    expect(busy.holder).not.toHaveProperty('tokenHash');
  });

  it('libera con el token suelto (p. ej. desde otro proceso) y rechaza tokens ajenos o mal formados', async () => {
    const locks = new LockManager({ root: tmp.root });
    const gpu = await locks.acquire('gpu', c7);
    const e2e = await locks.acquire('e2e', c7);
    expect((await lockError(locks.release('e2e', gpu.token))).code).toBe('not_owner');
    for (const bad of ['', 'abc', 'G'.repeat(32), { token: 42 }, null]) {
      expect((await lockError(locks.release('gpu', bad as unknown as Proof))).code).toBe('invalid_owner');
    }
    await new LockManager({ root: tmp.root }).release('gpu', gpu.token);
    await locks.release('e2e', e2e);
    expect(await locks.list()).toEqual([]);
  });

  it('withLock libera con su propio token', async () => {
    const locks = new LockManager({ root: tmp.root });
    let seen = '';
    await locks.withLock('gpu', c7, (lock) => { seen = lock.token; });
    expect(seen).toMatch(/^[0-9a-f]{32}$/);
    expect(await locks.read('gpu')).toBeUndefined();
  });
});
