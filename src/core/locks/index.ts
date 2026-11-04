import { LockManager } from './manager.ts';
import type { AcquireOptions, LockHandle, LockInfo, LockReleaseProof } from './manager.ts';
import type { LockIdentity, LockOwnerInput } from './owner.ts';

export { KNOWN_LOCKS, LOCK_POOLS, lockNameSchema } from './names.ts';
export type { KnownLock, LockPool } from './names.ts';
export { decodeOwner, encodeOwner, lockOwnerInputSchema, lockOwnerSchema, lockTokenSchema, skillIdentitySchema } from './owner.ts';
export type { LockHolder, LockIdentity, LockOwner, LockOwnerInput } from './owner.ts';
export { defaultLocksRoot, LockError, LockManager, OWNER_FILE } from './manager.ts';
export type { AcquireOptions, LockErrorCode, LockFs, LockHandle, LockInfo, LockManagerOptions, LockReleaseProof } from './manager.ts';

// Atajos sobre la raíz por defecto (`defaultLocksRoot()`, se lee en cada llamada).
// Para otra raíz o para inyectar el gestor en otros módulos: `new LockManager({ root })`.

export function acquire(name: string, owner: LockOwnerInput, options?: AcquireOptions): Promise<LockHandle> {
  return new LockManager().acquire(name, owner, options);
}

export function release(name: string, proof: LockReleaseProof): Promise<void> {
  return new LockManager().release(name, proof);
}

export function releaseSkillLock(name: string, identity: LockIdentity): Promise<void> {
  return new LockManager().releaseSkillLock(name, identity);
}

export function withLock<T>(name: string | readonly string[], owner: LockOwnerInput, fn: (lock: LockHandle) => Promise<T> | T, options?: AcquireOptions): Promise<T> {
  return new LockManager().withLock(name, owner, fn, options);
}

export function listStale(hours = 3): Promise<LockInfo[]> {
  return new LockManager().listStale(hours);
}
