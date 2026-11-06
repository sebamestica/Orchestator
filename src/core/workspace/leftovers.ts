import { lstat, realpath, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRunner } from './git.ts';
import { isInside } from './guard.ts';

/** Archivos no versionados ni ignorados del worktree (rutas relativas, como las da git). */
export async function listUntracked(git: GitRunner, cwd: string): Promise<string[]> {
  const out = (await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout;
  return out.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3));
}

/** Archivos versionados cuya copia de trabajo difiere del índice (lo que cambió alguien después del último merge o commit). */
export async function modifiedTracked(git: GitRunner, cwd: string): Promise<string[]> {
  return (await git(cwd, ['diff', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
}

/** Motivo para el autor cuando el gate cambió archivos versionados (no se confirma un árbol distinto del verificado). */
export function gateModifiedNote(files: readonly string[]): string {
  return `el gate modificó archivos versionados: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ` y ${String(files.length - 20)} más` : ''}`;
}

/**
 * Borra los archivos no versionados ni ignorados del worktree (restos de un gate o de un merge abortado) salvo los
 * de `keep`: en el de integración, para que no bloqueen el siguiente merge («untracked working tree files would be
 * overwritten»); en el de una tarea, para que no entren en su commit. Sin `git clean` (la guardia lo niega): se
 * borra archivo por archivo y **nunca** a través de una junction (Git para Windows lista el contenido de las
 * junctions como archivos propios).
 */
export async function removeUntracked(git: GitRunner, cwd: string, keep: ReadonlySet<string> = new Set()): Promise<string[]> {
  const untracked = (await listUntracked(git, cwd)).filter((rel) => !keep.has(rel));
  if (untracked.length === 0) return [];
  const root = await realpath(cwd);
  const removed: string[] = [];
  for (const rel of untracked) {
    const abs = join(cwd, rel);
    try {
      if ((await lstat(abs)).isSymbolicLink()) {
        await unlink(abs);
      } else {
        // Si alguna carpeta intermedia es un enlace, la ruta real sale del worktree: no se toca.
        if (!isInside(await realpath(abs), root)) continue;
        await rm(abs, { force: true });
      }
      removed.push(rel);
    } catch {
      /* desapareció o está retenido: el merge informará si estorba */
    }
  }
  return removed;
}
