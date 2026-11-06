import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Foto de una carpeta: ruta relativa (con `/`) → `tamaño:mtimeMs`. Sirve para saber qué cambió sin git. */
export type FolderSnapshot = ReadonlyMap<string, string>;

/** Carpetas que no se recorren: la de Berland, la de git y las dependencias (las cambia `npm install`, no la tarea). */
const SKIPPED = new Set(['.orq', '.git', 'node_modules']);
/** Tope de entradas: una carpeta más grande no se fotografía (cuesta más que lo que ahorra o vigila). */
export const SNAPSHOT_LIMIT = 50_000;

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
        const st = await lstat(join(dir, child));
        out.set(child, `${String(st.size)}:${String(st.mtimeMs)}`);
        if (out.size > limit) return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return out;
}

/** Rutas creadas, cambiadas o borradas entre dos fotos, en orden. */
export function changedPaths(before: FolderSnapshot, after: FolderSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, print] of after) if (before.get(path) !== print) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}
