/**
 * Disco del almacenamiento: medir y borrar sin salir nunca de las carpetas de Berland.
 * - Todo recorrido usa `lstat`: un enlace simbólico o una junction se mide como enlace (0 bytes) y se borra como
 *   enlace, sin entrar en él.
 * - `safetyProblem` comprueba, con la ruta nominal y con `realpath`, que el blanco esté dentro de su raíz y que no sea,
 *   contenga ni esté dentro de un camino protegido (proyectos, worktrees, bóveda, base, memoria), ni contenga la
 *   carpeta de datos.
 */
import type { Stats } from 'node:fs';
import { chmod, lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/** `target` está dentro de `root` (no es `root`). En Windows, sin distinguir mayúsculas (`path.relative`). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/** Son el mismo camino o uno está dentro del otro. */
export function overlaps(a: string, b: string): boolean {
  return samePath(a, b) || isInside(a, b) || isInside(b, a);
}

/** Clave para comparar rutas (en Windows sin mayúsculas). */
export function pathKey(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export interface SafetyRules {
  /** Caminos que nunca se tocan: ni ellos, ni lo que contienen, ni lo que los contiene. */
  protectedPaths: readonly string[];
  /** Carpetas que no se pueden borrar ni contener (la carpeta de datos); lo de dentro sí. */
  keepRoots: readonly string[];
}

async function realOf(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

async function forms(p: string): Promise<string[]> {
  const nominal = path.resolve(p);
  const real = await realOf(nominal);
  return real && !samePath(real, nominal) ? [nominal, real] : [nominal];
}

/**
 * Motivo por el que `target` no se puede borrar, o `undefined` si es seguro: tiene que existir, estar dentro de `root`
 * (también su ruta real) y no tocar nada protegido.
 */
export async function safetyProblem(target: string, root: string, rules: SafetyRules): Promise<string | undefined> {
  const t = path.resolve(target);
  const r = path.resolve(root);
  if (!isInside(r, t)) return 'está fuera de la carpeta de Berland';
  const realR = await realOf(r);
  // El blanco puede ser un enlace: su ruta real es la de su carpeta (el enlace en sí no se sigue).
  const realParent = await realOf(path.dirname(t));
  if (realR === undefined || realParent === undefined) return 'ya no existe';
  const realT = path.join(realParent, path.basename(t));
  if (!isInside(realR, realT)) return 'su ruta real está fuera de la carpeta de Berland';
  const mine = [t, realT];
  for (const p of rules.protectedPaths) {
    for (const f of await forms(p)) {
      if (mine.some((m) => overlaps(m, f))) return 'toca un proyecto, la bóveda, la base o la memoria';
    }
  }
  for (const k of rules.keepRoots) {
    for (const f of await forms(k)) {
      if (mine.some((m) => samePath(m, f) || isInside(m, f))) return 'contiene la carpeta de datos de Berland';
    }
  }
  return undefined;
}

export async function lstatOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await lstat(p);
  } catch {
    return undefined;
  }
}

export interface DirEntryInfo {
  name: string;
  path: string;
  stats: Stats;
}

/** Hijos directos de `dir` con su `lstat` (lista vacía si no existe). */
export async function listDir(dir: string): Promise<DirEntryInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: DirEntryInfo[] = [];
  for (let i = 0; i < names.length; i += 64) {
    const batch = await Promise.all(
      names.slice(i, i + 64).map(async (name) => {
        const p = path.join(dir, name);
        const stats = await lstatOrUndefined(p);
        return stats ? { name, path: p, stats } : undefined;
      }),
    );
    for (const e of batch) if (e) out.push(e);
  }
  return out;
}

/** Presupuesto de entradas de un recorrido (compartido entre carpetas): al agotarse, las cifras son un mínimo. */
export interface WalkBudget {
  left: number;
  truncated: boolean;
}

export const DEFAULT_WALK_ENTRIES = 250_000;

/** Bytes y archivos de un árbol, sin seguir enlaces ni junctions. */
export async function treeSize(dir: string, budget: WalkBudget = { left: DEFAULT_WALK_ENTRIES, truncated: false }): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const e of await listDir(current)) {
      if (budget.left <= 0) {
        budget.truncated = true;
        return { bytes, files };
      }
      budget.left--;
      if (e.stats.isSymbolicLink()) continue;
      if (e.stats.isDirectory()) stack.push(e.path);
      else if (e.stats.isFile()) {
        bytes += e.stats.size;
        files++;
      }
    }
  }
  return { bytes, files };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (err: unknown): string | undefined => (err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined);

/** Windows suelta tarde los archivos (antivirus, indexador): se reintenta un par de veces. */
async function retry(fn: () => Promise<void>): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      const code = codeOf(err);
      if (code === 'ENOENT') return;
      if (i >= 3 || !(code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EACCES')) throw err;
      await wait(100 * (i + 1));
    }
  }
}

async function removeFile(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (err) {
    const code = codeOf(err);
    if (code === 'ENOENT') return;
    if (code !== 'EPERM' && code !== 'EACCES') throw err;
    // Archivo de solo lectura (p. ej. los objetos de `.git`): se le quita la marca y se borra.
    await chmod(p, 0o666).catch(() => undefined);
    await retry(() => unlink(p));
  }
}

/** Quita el enlace o la junction en sí; nunca lo que hay al otro lado. */
async function removeLink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (err) {
    const code = codeOf(err);
    if (code === 'ENOENT') return;
    if (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EACCES') throw err;
    // Enlace de carpeta en Windows: `rmdir` quita el punto de reanálisis sin tocar el destino.
    await retry(() => rmdir(p));
  }
}

/** Borra un archivo o una carpeta entera sin seguir enlaces. Devuelve lo que ocupaban los archivos borrados. */
export async function removeTree(target: string): Promise<{ bytes: number; files: number }> {
  const stats = await lstatOrUndefined(target);
  if (!stats) return { bytes: 0, files: 0 };
  if (stats.isSymbolicLink()) {
    await removeLink(target);
    return { bytes: 0, files: 0 };
  }
  if (!stats.isDirectory()) {
    await removeFile(target);
    return { bytes: stats.size, files: 1 };
  }
  let bytes = 0;
  let files = 0;
  for (const e of await listDir(target)) {
    const r = await removeTree(e.path);
    bytes += r.bytes;
    files += r.files;
  }
  await retry(() => rmdir(target));
  return { bytes, files };
}
