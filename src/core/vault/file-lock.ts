/**
 * Candado entre procesos de la bóveda de claves y del hub de skills. Delega en `src/core/fs/dir-lock.ts`:
 * la versión anterior podía romper el candado de un tercero al liberar uno abandonado (lo reprodujo c4:
 * 11/12 incrementos con 12 procesos), y la nueva solo rompe un candado abandonado bajo un candado «rompedor»
 * tras releer que el dueño no cambió.
 */
import { withDirLock, type DirLockOptions } from '../fs/dir-lock.ts';

export { DirLockBusyError as FileLockBusyError } from '../fs/dir-lock.ts';
export type FileLockOptions = DirLockOptions;

/** Ejecuta `fn` con el candado `lockDir` tomado. Por defecto espera 10 s y reintenta cada 25 ms. */
export function withFileLock<T>(lockDir: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  return withDirLock(lockDir, fn, { timeoutMs: 10_000, retryMs: 25, ...opts });
}
