import { join } from 'node:path';

/**
 * Pruebas de sondeo (F6, docs/plan/F6-FLUJO-RAPIDO.md §2.3): scripts de prueba rápidos que el subagente `pruebas`
 * (Sonnet) escribe antes de que empiece la ejecución. Viven fuera del repo, en la carpeta de datos del núcleo, y la
 * flota los copia a `.orq/pruebas/` de cada worktree antes de cada intento: `.orq/` no entra en git.
 */

/** Carpeta del worktree (relativa a su raíz) donde la flota copia las pruebas de sondeo. */
export const PRUEBAS_WORKTREE_DIR = join('.orq', 'pruebas');

/** Carpeta de las pruebas de sondeo de un proyecto: `<dataDir>/pruebas/<proyecto>`. */
export function pruebasDir(dataDir: string, projectId: string): string {
  return join(dataDir, 'pruebas', projectId);
}

/** Nombre válido de un archivo de pruebas de sondeo: sin carpetas, sin «..», sin espacios. */
export const PRUEBA_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
/** Tope de un archivo de pruebas de sondeo (bytes UTF-8). */
export const MAX_PRUEBA_BYTES = 200 * 1024;
/** Tope de archivos de pruebas de sondeo por proyecto. */
export const MAX_PRUEBAS_POR_PROYECTO = 100;
