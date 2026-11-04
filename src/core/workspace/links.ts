import { existsSync, realpathSync } from 'node:fs';
import { appendFile, copyFile, lstat, mkdir, readdir, readFile, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { physicalPath } from './config.ts';
import type { GitRunner } from './git.ts';
import { isInside } from './guard.ts';

export interface LinkReport {
  created: string[];
  /** Rutas configuradas que no existen en la copia principal (no se enlazan). */
  missing: string[];
}

/**
 * Enlaza cada ruta de la copia principal dentro del worktree. Carpetas: `junction` en Windows (sin privilegios; en
 * el resto, enlace simbólico) hacia su ruta real, **compartidas** con la copia principal. Archivos: **copia** (un
 * enlace duro haría que escribir en el worktree cambiara el original, sin que se note).
 *
 * Contención física de lo que se comparte (comprobada al crear el enlace; ver el riesgo residual de carreras en
 * docs/proyectos/vetworld.md):
 * - la ruta real del origen (con sus carpetas intermedias, junctions incluidas) queda dentro de la ruta real del repo;
 * - **todo el árbol** de una carpeta compartida: no puede contener ningún enlace ni junction, interno o externo;
 * - la carpeta del enlace en el worktree: sus ancestros existentes se comprueban **antes** del `mkdir`, así un
 *   ancestro que sea junction hacia fuera no recibe ninguna carpeta.
 */
export async function createLinks(repoPath: string, worktreePath: string, links: readonly string[]): Promise<LinkReport> {
  const report: LinkReport = { created: [], missing: [] };
  const repoReal = realpathSync.native(repoPath);
  const worktreeReal = realpathSync.native(worktreePath);
  for (const rel of links) {
    const target = resolve(repoPath, rel);
    const linkPath = join(worktreePath, rel);
    if (!existsSync(target)) {
      report.missing.push(rel);
      continue;
    }
    const targetReal = realpathSync.native(target);
    if (!isInside(targetReal, repoReal)) {
      throw new Error(`no se puede enlazar «${rel}»: su ruta real (${targetReal}) sale del repo (${repoReal}) a través de un enlace o junction`);
    }
    const isDir = (await stat(targetReal)).isDirectory();
    if (isDir) await assertTreeInside(targetReal, rel);
    if (await pathExists(linkPath)) {
      throw new Error(`no se puede enlazar «${rel}»: ya existe en el worktree (¿está versionado?)`);
    }
    await assertRealAncestors(worktreePath, dirname(linkPath), rel);
    await mkdir(dirname(linkPath), { recursive: true });
    const parentReal = physicalPath(dirname(linkPath));
    if (!isInside(parentReal, worktreeReal)) {
      throw new Error(`no se puede enlazar «${rel}»: la carpeta del enlace (${parentReal}) sale del worktree a través de un enlace o junction`);
    }
    if (isDir) {
      await symlink(targetReal, linkPath, 'junction');
    } else {
      // Una junction a un archivo queda rota en NTFS (ENOENT al leerla) y un enlace duro comparte el contenido: copia.
      await copyFile(targetReal, linkPath);
    }
    report.created.push(rel);
  }
  return report;
}

/**
 * Recorre el árbol de una carpeta compartida (sin entrar en enlaces) y falla ante **cualquier** enlace o junction
 * descendiente, apunte dentro o fuera del repo (decisión de A0, 3.ª revisión de Codex): una junction interna
 * (`recursos\interno` → `repo\datos`) llevaría a otra parte del repo que no se ha revisado (`datos\externo` →
 * `D:\privado`). Rechazar todas es lo más simple y cerrado; Vetworld no tiene ninguna. Un error al listar también
 * falla: sin recorrido completo no hay garantía.
 */
async function assertTreeInside(dirReal: string, rel: string): Promise<void> {
  const stack = [dirReal];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`no se puede enlazar «${rel}»: no se pudo revisar ${dir} (${(err as NodeJS.ErrnoException).code ?? String(err)})`, { cause: err });
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(`no se puede enlazar «${rel}»: contiene un enlace o junction (${p}); una carpeta compartida no puede tener enlaces dentro`);
      }
      if (e.isDirectory()) stack.push(p);
    }
  }
}

/** Cada ancestro existente de `dir` entre el worktree y `dir` es una carpeta real (ni enlace ni junction). */
async function assertRealAncestors(worktreePath: string, dir: string, rel: string): Promise<void> {
  const parts = dir.slice(worktreePath.length).split(/[\\/]+/).filter(Boolean);
  let cur = worktreePath;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // lo que falta se crea dentro de una carpeta ya comprobada
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`no se puede enlazar «${rel}»: ${cur} es un enlace, una junction o un archivo dentro del worktree`);
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

const EXCLUDE_MARK = '# orq: enlaces de worktrees (no versionar)';

/**
 * Git para Windows recorre las junctions como carpetas: un enlace no ignorado aparecería como
 * archivos nuevos y un `git add -A` del agente los versionaría. Se añaden a `info/exclude`
 * (común a todos los worktrees) las rutas que aún no estén ignoradas.
 */
export async function excludeLinks(git: GitRunner, worktreePath: string, links: readonly string[]): Promise<string[]> {
  if (links.length === 0) return [];
  const slashed = links.map((rel) => rel.replace(/\\/g, '/'));
  // Una sola llamada: imprime las rutas que ya están ignoradas (código 1 si ninguna).
  const r = await git(worktreePath, ['check-ignore', '--no-index', '-z', '--', ...slashed], { check: false });
  const ignored = new Set(r.stdout.split('\0').filter(Boolean));
  const pending = slashed.filter((rel) => !ignored.has(rel));
  if (pending.length === 0) return [];
  const out = await git(worktreePath, ['rev-parse', '--git-common-dir']);
  const raw = out.stdout.trim();
  const commonDir = isAbsolute(raw) ? raw : resolve(worktreePath, raw);
  const excludeFile = join(commonDir, 'info', 'exclude');
  await mkdir(dirname(excludeFile), { recursive: true });
  const current = existsSync(excludeFile) ? await readFile(excludeFile, 'utf8') : '';
  const lines = pending.map((rel) => `/${rel}`).filter((l) => !current.split(/\r?\n/).includes(l));
  if (lines.length === 0) return [];
  const header = current.includes(EXCLUDE_MARK) ? '' : `${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCLUDE_MARK}\n`;
  await appendFile(excludeFile, `${header}${lines.join('\n')}\n`, 'utf8');
  return lines;
}

/** Operaciones de disco de `removeAllLinks` (inyectables para probar fallos de enumeración y de borrado). */
export interface LinkFs {
  readdir: (dir: string) => Promise<{ name: string; isSymbolicLink(): boolean; isDirectory(): boolean }[]>;
  unlink: (p: string) => Promise<void>;
  rmdir: (p: string) => Promise<void>;
}

const nodeLinkFs: LinkFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  unlink: (p) => unlink(p),
  rmdir: (p) => rmdir(p),
};

/** Quita un enlace sin seguirlo (el contenido de la copia principal queda intacto). */
async function unlinkLink(p: string, fs: LinkFs): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    // En Windows algunas junctions se quitan como carpeta vacía.
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') await fs.rmdir(p);
    else throw err;
  }
}

/**
 * Busca enlaces y junctions dentro del worktree (sin entrar en ellos ni en `.git`) y los quita.
 * Imprescindible antes de `git worktree remove`: git recorre la junction de un `node_modules`
 * ignorado y borra el contenido de la copia principal.
 *
 * El recorrido tiene que ser completo: solo se ignora una carpeta que desapareció (`ENOENT`); cualquier otro fallo
 * al listar (permisos, E/S) o al quitar un enlace se propaga, y quien llama no borra el worktree.
 */
export async function removeAllLinks(worktreePath: string, fs: LinkFs = nodeLinkFs): Promise<string[]> {
  const removed: string[] = [];
  const stack = [worktreePath];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`no se pudo revisar ${dir} en busca de enlaces (${(err as NodeJS.ErrnoException).code ?? String(err)}): el worktree no se borra`, { cause: err });
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        await unlinkLink(p, fs);
        removed.push(p);
      } else if (e.isDirectory() && !(dir === worktreePath && e.name === '.git')) {
        stack.push(p);
      }
    }
  }
  return removed;
}
