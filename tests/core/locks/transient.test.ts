// Hallazgo 4 de la revisión de agy (MEDIA): ante EPERM/EBUSY pasajeros con la carpeta en «delete pending»,
// tryAcquire devolvía busy sin reintentar porque stat() veía la carpeta; el backoff nunca se alcanzaba.
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockManager } from '../../../src/core/locks/index.ts';
import { c7, codex, fsError, lockError, useTmpRoot } from './helpers.ts';

const tmp = useTmpRoot();

/** mkdir del candado falla con `code` las primeras `failures` veces; mientras tanto la carpeta «existe» para stat. */
function deletePending(code: string, failures: number) {
  const state = { failures, calls: 0 };
  const lockPath = () => join(tmp.root, 'gpu');
  const manager = new LockManager({
    root: tmp.root,
    fs: {
      mkdir: async (path, options) => {
        if (path === lockPath() && !options?.recursive) {
          state.calls++;
          if (state.failures > 0) { state.failures--; throw fsError(code, 'mkdir'); }
        }
        return mkdir(path, options);
      },
      // En delete pending la carpeta aún aparece, pero su owner ya no se puede leer.
      stat: async (path) => (path === lockPath() && state.failures > 0 ? { isDirectory: () => true, mtimeMs: Date.now() } : stat(path)),
    },
  });
  return { manager, state };
}

describe('errores pasajeros de Windows al tomar (hallazgo 4)', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('reintenta con backoff ante %s sin owner legible y toma el candado sin espera', async (code) => {
    const { manager, state } = deletePending(code, 3);
    const handle = await manager.acquire('gpu', c7);
    expect(state).toMatchObject({ failures: 0, calls: 4 });
    expect(handle.name).toBe('gpu');
    await handle.release();
  });

  it('da busy de inmediato si hay un owner legible', async () => {
    await new LockManager({ root: tmp.root }).acquire('gpu', codex);
    const { manager, state } = deletePending('EPERM', 100);
    const busy = await lockError(manager.acquire('gpu', c7));
    expect(busy).toMatchObject({ code: 'busy', holder: { agent: 'codex' } });
    expect(state.calls).toBe(1);
  });

  it('si el error persiste sin owner, lanza el error del sistema tras los reintentos', async () => {
    const { manager, state } = deletePending('EPERM', 100);
    await expect(manager.acquire('gpu', c7)).rejects.toMatchObject({ code: 'EPERM', syscall: 'mkdir' });
    expect(state.calls).toBe(6);
  });
});
