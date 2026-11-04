import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { LockError, OWNER_FILE } from '../../../src/core/locks/index.ts';

export const c7 = { agent: 'c7', task: 'c7-locks' };
export const codex = { agent: 'codex', task: 'fichas-razas' };
export const agy = { agent: 'agy', task: 'render' };

export async function lockError(promise: Promise<unknown>): Promise<LockError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LockError) return error;
    throw error;
  }
  throw new Error('se esperaba un LockError');
}

/** Resultado de una promesa sin lanzar: el valor o el error. */
export function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then((value) => value ?? 'ok', (error: unknown) => error);
}

/** Raíz temporal nueva para cada prueba; se borra al terminar. */
export function useTmpRoot(): { readonly root: string } {
  const state = { root: '' };
  beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), 'orq-locks-')); });
  afterEach(async () => { await rm(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return state;
}

/** Candado creado como en la skill (bash): `mkdir` + `echo "<agente> <tarea> <fecha>" > owner`. */
export async function skillLock(root: string, name: string, owner: string | Uint8Array): Promise<string> {
  const path = join(root, name);
  await mkdir(path);
  await writeFile(join(path, OWNER_FILE), owner);
  return path;
}

/** Error de sistema simulado, con `code` como los de Node. */
export function fsError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${code}: simulado, ${syscall}`), { code, syscall });
}
