import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Foto de una carpeta: ruta relativa (con `/`) → huella (`tamaño:hash` de los archivos chicos, `tamaño:mtimeMs` del
 * resto). Sirve para saber qué cambió sin git; con el hash, un archivo devuelto a su contenido cuenta como sin cambios.
 */
export type FolderSnapshot = ReadonlyMap<string, string>;

/** Carpetas que no se recorren: la de Berland, la de git y las dependencias (las cambia una instalación, no la tarea). */
const SKIPPED = new Set(['.orq', '.git', 'node_modules', '.venv']);
/** Tope de entradas: una carpeta más grande no se fotografía (cuesta más que lo que ahorra o vigila). */
export const SNAPSHOT_LIMIT = 50_000;
/** Archivos hasta este tamaño se comparan por contenido. */
const HASH_MAX_BYTES = 256 * 1024;

/**
 * Foto de `dir` sin seguir enlaces (un enlace cuenta como entrada, pero no se recorre). `undefined` si la carpeta pasa
 * de `limit` entradas o no se puede leer: quien la usa debe suponer entonces que todo pudo cambiar.
 */
export async function snapshotFolder(dir: string, limit = SNAPSHOT_LIMIT): Promise<FolderSnapshot | undefined> {
  const out = new Map<string, string>();
  const pending: string[] = [''];
  try {
    for (let rel = pending.pop(); rel !== undefined; rel = pending.pop()) {
      for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIPPED.has(entry.name)) pending.push(child);
          continue;
        }
        out.set(child, await fileprint(join(dir, child)));
        if (out.size > limit) return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return out;
}

/** Huella de un archivo; uno que desaparece o no se puede leer mientras se recorre queda como `?` (cuenta como cambio). */
async function fileprint(path: string): Promise<string> {
  try {
    const st = await lstat(path);
    const print = st.isFile() && st.size <= HASH_MAX_BYTES ? createHash('sha1').update(await readFile(path)).digest('hex') : String(st.mtimeMs);
    return `${String(st.size)}:${print}`;
  } catch {
    return '?';
  }
}

/** Rutas creadas, cambiadas o borradas entre dos fotos, en orden. */
export function changedPaths(before: FolderSnapshot, after: FolderSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, print] of after) if (before.get(path) !== print) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}
