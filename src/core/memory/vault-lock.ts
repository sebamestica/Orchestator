/** Candado entre procesos de la bóveda de memoria: la implementación vive en `src/core/fs/dir-lock.ts`. */
export { DirLockBusyError as VaultLockBusyError, withDirLock as withVaultLock } from '../fs/dir-lock.ts';
export type { DirLockOptions as VaultLockOptions } from '../fs/dir-lock.ts';
