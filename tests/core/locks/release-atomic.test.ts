// Hallazgo 1 de la revisión de agy (ALTA): release leía owner y después borraba con rm, en dos pasos.
// Si entretanto el candado cambiaba de dueño, se borraba el del nuevo dueño.
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockManager, OWNER_FILE } from '../../../src/core/locks/index.ts';
import type { LockFs } from '../../../src/core/locks/index.ts';
import { agy, c7, codex, fsError, settle, useTmpRoot } from './helpers.ts';

const tmp = useTmpRoot();

/**
 * Gestor cuyo primer cambio en disco sobre la carpeta del candado (rm o rename) va precedido de `swap`:
 * así se reproduce que otro dueño tome el candado entre la comprobación y el borrado.
 */
function racingManager(lock: string, swap: () => Promise<void>, extra: Partial<LockFs> = {}) {
  const state = { armed: false, swapped: false };
  const before = async (path: string) => {
    if (!state.armed || state.swapped || path !== join(tmp.root, lock)) return;
    state.swapped = true;
    await swap();
  };
  const manager = new LockManager({
    root: tmp.root,
    fs: {
      rm: async (path, options) => { await before(path); return rm(path, options); },
      rename: async (from, to) => { await before(from); return rename(from, to); },
      ...extra,
    },
  });
  return { manager, state };
}

describe('release atómico (hallazgo 1)', () => {
  it('si el candado cambia de dueño justo antes de borrarlo, no borra el del nuevo dueño', async () => {
    const other = new LockManager({ root: tmp.root });
    // A deja de tener el candado (doble liberación, limpieza) y B lo toma legítimamente.
    const { manager, state } = racingManager('gpu', async () => {
      await rm(join(tmp.root, 'gpu'), { recursive: true, force: true });
      await other.acquire('gpu', codex);
    });
    const handle = await manager.acquire('gpu', c7);
    state.armed = true;
    const outcome = await settle(handle.release());
    expect(state.swapped).toBe(true);
    expect((await other.read('gpu'))?.holder).toMatchObject({ format: 'json', agent: 'codex' });
    expect(outcome).toMatchObject({ code: 'not_owner' });
    // Nada apartado quedó atrás.
    expect(await readdir(tmp.root)).toEqual(['gpu']);
  });

  it('si al devolver la carpeta ajena el nombre ya fue tomado, informa y no borra nada', async () => {
    const other = new LockManager({ root: tmp.root });
    let releasingPath = '';
    const { manager, state } = racingManager(
      'gpu',
      async () => {
        await rm(join(tmp.root, 'gpu'), { recursive: true, force: true });
        await other.acquire('gpu', codex);
      },
      {
        // Mientras la carpeta de B está apartada, C toma el nombre libre.
        readFile: async (path) => {
          const content = await readFile(path);
          if (state.swapped && !releasingPath && path.includes('.releasing.')) {
            releasingPath = join(path, '..');
            await other.acquire('gpu', agy);
          }
          return content;
        },
      },
    );
    const handle = await manager.acquire('gpu', c7);
    state.armed = true;
    const outcome = await settle(handle.release());
    expect(outcome).toMatchObject({ code: 'conflict', holder: { agent: 'codex' } });
    expect(String((outcome as Error).message)).toContain(releasingPath);
    // C conserva el candado y la carpeta de B sigue entera (apartada), para que A0 decida.
    expect((await other.read('gpu'))?.holder.agent).toBe('agy');
    expect(JSON.parse(await readFile(join(releasingPath, OWNER_FILE), 'utf8'))).toMatchObject({ agent: 'codex' });
    // Y queda a la vista en list() como carpeta en liberación.
    const listed = await other.list();
    expect(listed.map((l) => [l.name, l.holder.agent, l.releasing ?? false])).toEqual([['gpu', 'agy', false], ['gpu', 'codex', true]]);
  });

  it('reintenta el apartado ante EPERM/EBUSY pasajeros de Windows y libera', async () => {
    let failures = 2;
    const manager = new LockManager({
      root: tmp.root,
      fs: {
        rename: async (from, to) => {
          if (from === join(tmp.root, 'gpu') && failures > 0) { failures--; throw fsError(failures ? 'EBUSY' : 'EPERM', 'rename'); }
          return rename(from, to);
        },
      },
    });
    const handle = await manager.acquire('gpu', c7);
    await handle.release();
    expect(failures).toBe(0);
    expect(await readdir(tmp.root)).toEqual([]);
  });
});
