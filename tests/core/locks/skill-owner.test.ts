// Hallazgo 3 de la revisión de agy (MEDIA): el owner en texto de la skill con `date -I` (sin hora) no se reconocía
// y la fecha se pegaba a la tarea; con tareas con espacios, la liberación fallaba con invalid_owner.
import { utimes } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeOwner, LockManager } from '../../../src/core/locks/index.ts';
import { lockError, skillLock, useTmpRoot } from './helpers.ts';

const tmp = useTmpRoot();
const text = (value: string) => new TextEncoder().encode(value);

describe('owner en texto de la skill (hallazgo 3)', () => {
  it('reconoce la fecha de `date -I` y no la pega a la tarea', () => {
    expect(decodeOwner(text('agy build-app 2026-11-01\n'))).toMatchObject({ format: 'text', agent: 'agy', task: 'build-app', at: '2026-11-01' });
    expect(decodeOwner(text('agy fichas de razas 2026-11-01\n'))).toMatchObject({ task: 'fichas de razas', at: '2026-11-01' });
    // Lo que no es fecha sigue siendo parte de la tarea.
    expect(decodeOwner(text('agy build 2026-13-45\n'))).toMatchObject({ task: 'build 2026-13-45' });
    expect(decodeOwner(text('agy build\n'))).toEqual({ format: 'text', agent: 'agy', task: 'build', raw: 'agy build' });
  });

  it('la liberación de mantenimiento suelta un candado de la skill con fecha `date -I`', async () => {
    const locks = new LockManager({ root: tmp.root });
    await skillLock(tmp.root, 'gpu', 'agy build-app 2026-11-01\n');
    await locks.releaseSkillLock('gpu', { agent: 'agy', task: 'build-app' });
    expect(await locks.read('gpu')).toBeUndefined();
  });

  it('la liberación de mantenimiento admite tareas con espacios y exige agente y tarea exactos', async () => {
    const locks = new LockManager({ root: tmp.root });
    await skillLock(tmp.root, 'heavy-cpu-1', 'agy fichas de razas 2026-11-01T22:05:13-03:00\n');
    expect((await lockError(locks.releaseSkillLock('heavy-cpu-1', { agent: 'agy', task: 'fichas de otras' }))).code).toBe('not_owner');
    expect((await lockError(locks.releaseSkillLock('heavy-cpu-1', { agent: 'codex', task: 'fichas de razas' }))).code).toBe('not_owner');
    for (const bad of [{ agent: 'a b', task: 'x' }, { agent: 'agy', task: '   ' }, { agent: 'agy', task: 'x\u0000y' }]) {
      expect((await lockError(locks.releaseSkillLock('heavy-cpu-1', bad))).code).toBe('invalid_owner');
    }
    // Los espacios sobrantes se normalizan igual que al leer el owner.
    await locks.releaseSkillLock('heavy-cpu-1', { agent: 'agy', task: '  fichas  de razas ' });
    expect(await locks.read('heavy-cpu-1')).toBeUndefined();
  });

  it('con fecha sin hora, la antigüedad sale de la carpeta (más precisa que el día)', async () => {
    const locks = new LockManager({ root: tmp.root });
    const path = await skillLock(tmp.root, 'gpu', 'agy build-app 2020-01-01\n');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await utimes(path, twoHoursAgo, twoHoursAgo);
    const info = await locks.read('gpu');
    expect(info?.holder.at).toBe('2020-01-01');
    expect(info?.since).toBe(twoHoursAgo.toISOString());
  });
});
