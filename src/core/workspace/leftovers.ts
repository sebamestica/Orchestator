import { lstat, realpath, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRunner } from './git.ts';
import { isInside } from './guard.ts';

/**
 * Borra los archivos no versionados ni ignorados del worktree de integración (restos de un gate o de un
 * merge abortado) para que no bloqueen el siguiente merge («untracked working tree files would be
 * overwritten»). Sin `git clean` (la guardia lo niega): se borra archivo por archivo y **nunca** a través de
 * una junction (Git para Windows lista el contenido de las junctions como archivos propios).
 */
export async function removeUntracked(git: GitRunner, cwd: string): Promise<string[]> {
  const out = (await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout;
  const untracked = out.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3));
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
