/**
 * Candado entre procesos por carpeta (única implementación del núcleo; la usan la memoria, la bóveda de claves
 * y el hub de skills). Escrito por c4 a partir de `src/core/vault/file-lock.ts` (c5):
 * `mkdir` atómico (falla si la carpeta existe, también en Windows) + `owner` con pid, equipo y un token,
 * y liberación de candados abandonados (proceso muerto en este equipo, o más viejo que `staleMs`).
 *
 * Diferencia: un candado abandonado solo se rompe bajo un segundo candado «rompedor» (`<candado>.rompiendo`)
 * y después de releer que el dueño sigue siendo el mismo que se juzgó muerto. Sin esto, con procesos que
 * terminan justo al soltar el candado, otro proceso que leyó al dueño anterior lo ve muerto y renombra el
 * candado que ya tomó un tercero; en ese instante un cuarto lo toma y dos escriben a la vez (se observó con
 * 8 procesos: 7 de 8 sesiones en Contexto.md).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export interface DirLockOptions {
  /** Espera máxima para tomar el candado. Por defecto 30 s. */
  timeoutMs?: number;
  /** Pausa entre intentos (±25 % al azar). Por defecto 10 ms. */
  retryMs?: number;
  /** Antigüedad a partir de la cual un candado se considera abandonado aunque su proceso parezca vivo. Por defecto 60 s. */
  staleMs?: number;
  /** ¿Sigue vivo el proceso? Inyectable en pruebas. */
  isAlive?: (pid: number) => boolean;
}

export class DirLockBusyError extends Error {
  override readonly name = 'DirLockBusyError';
}

const OWNER = 'owner';
const ownerSchema = z.object({ pid: z.number().int().positive(), host: z.string(), at: z.string(), token: z.string() });
type Owner = z.infer<typeof ownerSchema>;

function code(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/** EPERM/EACCES/EBUSY: en Windows, la carpeta de otro candado se está borrando. */
const TRANSIENT = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return code(err) === 'EPERM'; // existe pero es de otro usuario
  }
}

async function readOwner(dir: string): Promise<Owner | undefined> {
  try {
    const parsed = ownerSchema.safeParse(JSON.parse(await readFile(path.join(dir, OWNER), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function ageMs(dir: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(dir)).mtimeMs;
  } catch {
    return undefined;
  }
}

const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });

/** Crea la carpeta del candado y su `owner`. False si otro la tiene (o se está borrando). */
async function tryTake(dir: string, me: Owner): Promise<boolean> {
  try {
    await mkdir(dir);
  } catch (err) {
    if (TRANSIENT.has(code(err) ?? '')) return false;
    throw err;
  }
  try {
    await writeFile(path.join(dir, OWNER), JSON.stringify({ ...me, at: new Date().toISOString() }), 'utf8');
    return true;
  } catch (err) {
    await removeDir(dir);
    throw err;
  }
}

/** Rompe el candado si está abandonado; true si lo rompió y conviene reintentar ya. */
async function breakIfAbandoned(dir: string, staleMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const owner = await readOwner(dir);
  const age = await ageMs(dir);
  if (age === undefined) return false; // desapareció o se está borrando: se reintenta tras la pausa
  const deadHere = owner !== undefined && owner.host === hostname() && !isAlive(owner.pid);
  if (!deadHere && age < staleMs) return false;

  const breaker = `${dir}.rompiendo`;
  const me: Owner = { pid: process.pid, host: hostname(), at: '', token: randomBytes(8).toString('hex') };
  if (!(await tryTake(breaker, me))) {
    // Un rompedor que murió a mitad de su trabajo (dura milisegundos) se descarta por antigüedad.
    const breakerAge = await ageMs(breaker);
    if (breakerAge !== undefined && breakerAge >= staleMs) await removeDir(breaker);
    return false;
  }
  try {
    // Bajo el rompedor nadie más puede borrar `dir`, y un dueño muerto no lo suelta: si el dueño
    // releído es el mismo que se juzgó abandonado, el candado no cambió de manos.
    const again = await readOwner(dir);
    const againAge = await ageMs(dir);
    if (againAge === undefined) return false;
    const same = owner ? again?.token === owner.token : again === undefined && againAge >= staleMs;
    if (!same) return false;
    await removeDir(dir);
    return true;
  } finally {
    if ((await readOwner(breaker))?.token === me.token) await removeDir(breaker);
  }
}

/** Ejecuta `fn` con el candado `dir` tomado. Lanza `DirLockBusyError` si no lo consigue en `timeoutMs`. */
export async function withDirLock<T>(dir: string, fn: () => Promise<T>, opts: DirLockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retryMs = opts.retryMs ?? 10;
  const staleMs = opts.staleMs ?? 60_000;
  const isAlive = opts.isAlive ?? processAlive;
  const me: Owner = { pid: process.pid, host: hostname(), at: '', token: randomBytes(8).toString('hex') };
  const deadline = Date.now() + timeoutMs;
  await mkdir(path.dirname(dir), { recursive: true });

  while (!(await tryTake(dir, me))) {
    if (await breakIfAbandoned(dir, staleMs, isAlive)) continue;
    if (Date.now() >= deadline) throw new DirLockBusyError(`candado ocupado: ${dir}`);
    await new Promise((resolve) => { setTimeout(resolve, retryMs * (0.75 + Math.random() * 0.5)); });
  }
  try {
    return await fn();
  } finally {
    if ((await readOwner(dir))?.token === me.token) await removeDir(dir);
  }
}
