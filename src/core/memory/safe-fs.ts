/**
 * Rutas y escrituras seguras dentro de una carpeta raíz (bóveda de Obsidian, cuarentena de skills).
 *
 * - `resolveInside` rechaza rutas absolutas, unidades (`C:`), UNC, segmentos `..`, flujos alternos de
 *   NTFS (`a:b`), caracteres inválidos en Windows y nombres de dispositivo (`CON`, `NUL`…).
 * - `realOrNearest` da la ruta real (sigue enlaces simbólicos y junctions), aunque el final aún no exista.
 * - `assertRealInside` resuelve enlaces simbólicos y junctions: la ruta real debe seguir dentro de la raíz.
 * - `writeFileAtomic` escribe en un temporal del mismo directorio y lo renombra sobre el destino.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class UnsafePathError extends Error {
  override readonly name = 'UnsafePathError';
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// eslint-disable-next-line no-control-regex -- se buscan justamente los caracteres de control
const INVALID_CHARS = /[<>:"|?*\u0000-\u001F]/;

/** Divide una ruta relativa en segmentos seguros o lanza `UnsafePathError`. */
export function safeSegments(relative: string): string[] {
  if (relative === '' || relative.includes('\0')) throw new UnsafePathError('ruta vacía o con carácter nulo');
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new UnsafePathError(`ruta absoluta no permitida: ${relative}`);
  }
  const parts = relative.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) throw new UnsafePathError(`ruta sin nombre: ${relative}`);
  for (const part of parts) {
    if (part === '..') throw new UnsafePathError(`segmento «..» no permitido: ${relative}`);
    if (INVALID_CHARS.test(part)) throw new UnsafePathError(`carácter no permitido en «${part}»`);
    if (/[. ]$/.test(part)) throw new UnsafePathError(`nombre terminado en punto o espacio: «${part}»`);
    if (WINDOWS_DEVICE.test(part.split('.')[0] ?? '')) throw new UnsafePathError(`nombre reservado de Windows: «${part}»`);
  }
  return parts;
}

/** True si `target` es `root` o está debajo (comparación léxica, sin tocar el disco). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '') return true;
  return !path.isAbsolute(relative) && relative.split(/[\\/]/)[0] !== '..';
}

/** Ruta absoluta de `relative` dentro de `root`; nunca devuelve la raíz misma ni algo fuera de ella. */
export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...safeSegments(relative));
  if (target === base || !isInside(base, target)) throw new UnsafePathError(`ruta fuera de la raíz: ${relative}`);
  return target;
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/**
 * Ruta real de `target` en disco (sigue enlaces y junctions): `realpath` del ancestro existente más cercano más los
 * segmentos que todavía no existen. Si no existe ni la raíz de la unidad, no hay enlaces que seguir: la ruta tal cual.
 * Lanza si `realpath` falla por otro motivo (permisos, E/S).
 */
export async function realOrNearest(target: string): Promise<string> {
  const absolute = path.resolve(target);
  let probe = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(probe), ...missing);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return absolute;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/** Comprueba en disco (siguiendo enlaces y junctions) que el ancestro existente más cercano de `target` está dentro de `root`. */
export async function assertRealInside(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root);
  if (!isInside(realRoot, await realOrNearest(target))) throw new UnsafePathError(`la ruta real sale de la raíz: ${target}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Repite `op` mientras falle con EPERM, EACCES o EBUSY: en Windows el antivirus (u Obsidian) abre un instante
 * el archivo recién escrito y `rename` o `copyFile` sobre él fallan. Esperas cortas y crecientes: 5, 10, 20… ms
 * (≈ 1,3 s en total).
 */
export async function retryWhileBusy<T>(op: () => Promise<T>, attempts = 9): Promise<T> {
  for (let k = 1; ; k++) {
    try {
      return await op();
    } catch (err) {
      const code = errorCode(err);
      if (k >= attempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err;
      await sleep(5 * 2 ** (k - 1));
    }
  }
}

/** `rename` con los reintentos de `retryWhileBusy`. `renameFn` solo se cambia en pruebas. */
export function renameWithRetry(from: string, to: string, attempts = 9, renameFn: (from: string, to: string) => Promise<void> = rename): Promise<void> {
  return retryWhileBusy(() => renameFn(from, to), attempts);
}

/** Escritura atómica dentro de `root`: temporal en el mismo directorio + `rename`. Crea las carpetas que falten. */
export async function writeFileAtomic(root: string, target: string, content: string | Uint8Array): Promise<void> {
  const absolute = path.resolve(target);
  if (absolute === path.resolve(root) || !isInside(root, absolute)) throw new UnsafePathError(`escritura fuera de la raíz: ${target}`);
  const dir = path.dirname(absolute);
  await mkdir(root, { recursive: true });
  await assertRealInside(root, dir);
  await mkdir(dir, { recursive: true });
  await assertRealInside(root, dir);
  const tmp = path.join(dir, `.${path.basename(absolute)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, content, { flag: 'wx', flush: true });
    await renameWithRetry(tmp, absolute);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Crea el archivo con su contenido solo si no existe (`wx`, exclusivo también en Windows): true si lo creó,
 * false si ya existía. Para notas nuevas: dos escritores nunca eligen el mismo archivo ni se pisan.
 */
export async function createFileExclusive(root: string, target: string, content: string | Uint8Array): Promise<boolean> {
  const absolute = path.resolve(target);
  if (absolute === path.resolve(root) || !isInside(root, absolute)) throw new UnsafePathError(`escritura fuera de la raíz: ${target}`);
  const dir = path.dirname(absolute);
  await mkdir(root, { recursive: true });
  await assertRealInside(root, dir);
  await mkdir(dir, { recursive: true });
  await assertRealInside(root, dir);
  try {
    await writeFile(absolute, content, { flag: 'wx' });
    return true;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    await rm(absolute, { force: true }); // escritura a medias (disco lleno…): no dejar una nota truncada
    throw err;
  }
}
