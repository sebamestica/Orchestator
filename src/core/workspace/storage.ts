/**
 * Dónde guarda los cambios una carpeta, con git de solo lectura: si es git, su rama actual y sus remotos con la URL
 * saneada. Lo usa la línea «¿se guarda en local o se sube?» del chat (`GET /chats/:id/target`).
 *
 * Todo git pasa por `createGitRunner` (la guardia del módulo): `remote`, `rev-parse --abbrev-ref HEAD` y
 * `rev-parse --git-path <archivo>`. La guardia no deja leer `remote.<nombre>.url` ni lanzar `symbolic-ref` (y no debe
 * abrírselos a los agentes), así que la URL sale del archivo `config` del repositorio (el común, también desde un
 * worktree) y la rama de un repositorio sin commits, de su `HEAD`. Esos archivos solo se leen.
 *
 * Límites conocidos: no se siguen `include.path`/`includeIf` ni se aplica `url.<base>.insteadOf`; un remoto definido
 * solo fuera del repositorio (config global) sale con la URL vacía.
 */
import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { redactSecrets } from '../../shared/index.ts';
import { createGitRunner, type GitRunner } from './git.ts';

export interface GitRemote {
  name: string;
  /** Saneada con `sanitizeRemoteUrl`; vacía si no se pudo leer. */
  url: string;
}

export type ProjectStorageKind = 'none' | 'local' | 'remote';

/**
 * Almacenamiento de una carpeta: `none` si no es git, `local` si es git sin remotos y `remote` si los tiene.
 * `branch`: la rama actual (`null` con HEAD separado o sin git).
 */
export interface ProjectStorage {
  kind: ProjectStorageKind;
  branch: string | null;
  /** Remoto preferido: `origin` si existe; si no, el primero. */
  remote: GitRemote | null;
  /** Todos los remotos, en el orden de `git remote`. */
  remotes: GitRemote[];
}

export interface StorageReadOptions {
  /** Ejecutor de git (por defecto `createGitRunner()`, con la guardia y el git del PATH del núcleo). */
  git?: GitRunner;
  timeoutMs?: number;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** Tope de `config` y `HEAD` que se leen (un `config` normal ocupa unos pocos KB). */
const MAX_GIT_FILE_BYTES = 1024 * 1024;

/** Repositorio git propio de la carpeta: tiene `.git` (carpeta, o archivo en un worktree), igual que el explorador. */
export async function hasGitDir(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * URL de un remoto para mostrarla: sin usuario, contraseña, token, consulta ni fragmento
 * (`https://token@github.com/a/b` → `https://github.com/a/b`). Formato SCP de SSH (`git@host:ruta(.git)`) → `host/ruta`.
 * Además pasa por `redactSecrets`.
 */
export function sanitizeRemoteUrl(raw: string): string {
  const url = raw.trim();
  // SCP: [usuario@]host:ruta, sin «://» y con host de más de una letra (`C:\repo` es una ruta de Windows).
  const scp = /^(?:[^@/\\\s]+@)?([^@:/\\\s]{2,}):(?!\/\/)(.+)$/.exec(url);
  if (scp?.[1] && scp[2]) return redactSecrets(`${scp[1]}/${scp[2].replace(/^\/+/, '').replace(/\.git$/, '')}`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    try {
      const u = new URL(url);
      return redactSecrets(`${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`);
    } catch {
      // URL que no se analiza: se quita a mano lo que va antes de la última «@» de la autoridad.
      const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/]*)(.*)$/.exec(url);
      if (m) return redactSecrets(`${m[1] ?? ''}${(m[2] ?? '').replace(/^.*@/, '')}${(m[3] ?? '').replace(/[?#].*$/, '')}`);
    }
  }
  return redactSecrets(url);
}

/**
 * Clave para comparar dos URLs del mismo repositorio: saneada, sin esquema, sin puerto, sin `.git` ni barra final y en
 * minúsculas (`https://github.com/a/b.git`, `git@github.com:a/b.git` y `ssh://git@github.com:22/a/b` dan lo mismo).
 */
export function remoteUrlKey(url: string): string {
  return sanitizeRemoteUrl(url)
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '')
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^([^/\\:]+):\d+(?=[\\/]|$)/, '$1')
    .toLowerCase();
}

/** Las dos URLs apuntan al mismo repositorio (`remoteUrlKey`). Una URL vacía no coincide con nada. */
export function sameRemoteUrl(a: string, b: string): boolean {
  const ka = remoteUrlKey(a);
  return ka !== '' && ka === remoteUrlKey(b);
}

/**
 * Valor de una entrada de config de git desde `from` (lo que sigue al `=`): comillas, escapes (`\"`, `\\`, `\n`, `\t`),
 * comentarios (`#`, `;`) fuera de comillas y continuación con `\` al final de la línea. Devuelve el valor y la última
 * línea que consumió.
 */
function readConfigValue(lines: readonly string[], start: number, from: string): { value: string; last: number } {
  let out = '';
  let space = '';
  let quoted = false;
  let line = start;
  let text = from;
  let i = 0;
  for (;;) {
    if (i >= text.length) break;
    const c = text[i++] ?? '';
    if (c === '\\') {
      if (i >= text.length) {
        // Continuación: el valor sigue en la línea siguiente.
        line += 1;
        if (line >= lines.length) break;
        text = lines[line] ?? '';
        i = 0;
        continue;
      }
      const e = text[i++] ?? '';
      out += space + (e === 'n' ? '\n' : e === 't' ? '\t' : e === 'b' ? '' : e);
      space = '';
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (c === '#' || c === ';')) break;
    if (!quoted && (c === ' ' || c === '\t')) {
      // Espacios sin comillas: se conservan entre palabras, no al principio ni al final.
      if (out) space += c;
      continue;
    }
    out += space + c;
    space = '';
  }
  return { value: out, last: line };
}

/**
 * URLs de los remotos de un archivo `config` de git (`[remote "origin"]` → `url = …`). Si un remoto tiene varias
 * `url`, vale la primera (la de `git remote get-url`). Las URLs salen tal cual: sanearlas es del llamador.
 */
export function parseRemoteUrls(configText: string): Map<string, string> {
  const urls = new Map<string, string>();
  const lines = configText.replace(/\r\n?/g, '\n').split('\n');
  let remote: string | null = null;
  for (let n = 0; n < lines.length; n += 1) {
    let line = (lines[n] ?? '').trimStart();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\\n]|\\.)*)")?\s*\]/.exec(line);
    if (header) {
      const [section = '', ...dotted] = (header[1] ?? '').split('.');
      // `[remote "x"]` distingue mayúsculas en el nombre; la forma antigua `[remote.x]`, no.
      const sub = header[2] !== undefined ? header[2].replace(/\\(.)/g, '$1') : dotted.length ? dotted.join('.').toLowerCase() : null;
      remote = section.toLowerCase() === 'remote' && sub ? sub : null;
      line = line.slice(header[0].length).trimStart();
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(=)?(.*)$/.exec(line);
    if (!entry) continue;
    if (entry[2] !== '=') continue;
    const { value, last } = readConfigValue(lines, n, entry[3] ?? '');
    n = last;
    if (remote !== null && (entry[1] ?? '').toLowerCase() === 'url' && !urls.has(remote)) urls.set(remote, value);
  }
  return urls;
}

/** Lee un archivo del repositorio por `git rev-parse --git-path` (el común o el del worktree, según el archivo). */
async function readGitFile(git: GitRunner, dir: string, name: 'HEAD' | 'config'): Promise<string | undefined> {
  const where = await git(dir, ['rev-parse', '--git-path', name], { check: false });
  const rel = where.code === 0 ? where.stdout.trim() : '';
  if (!rel) return undefined;
  const file = isAbsolute(rel) ? rel : resolve(dir, rel);
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_GIT_FILE_BYTES) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Rama actual; `null` con HEAD separado. En un repositorio sin commits, la rama a la que apunta `HEAD`. */
async function currentBranch(git: GitRunner, dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { check: false });
  if (r.code === 0) {
    const branch = r.stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  }
  const head = await readGitFile(git, dir, 'HEAD');
  const m = head ? /^ref:\s*refs\/heads\/(\S+)\s*$/m.exec(head) : null;
  // `.invalid` es el HEAD de relleno de los repositorios reftable.
  return m?.[1] && m[1] !== '.invalid' ? m[1] : null;
}

/**
 * Almacenamiento de la carpeta (ver `ProjectStorage`). Si la carpeta no tiene `.git`, si git no corre o si `git remote`
 * falla, da `none`: no hay cómo subir nada desde ahí.
 */
export async function readProjectStorage(dir: string, opts: StorageReadOptions = {}): Promise<ProjectStorage> {
  const none: ProjectStorage = { kind: 'none', branch: null, remote: null, remotes: [] };
  if (!(await hasGitDir(dir))) return none;
  const git = opts.git ?? createGitRunner(opts.timeoutMs !== undefined ? { defaultTimeoutMs: opts.timeoutMs } : {});
  try {
    const listed = await git(dir, ['remote'], { check: false });
    if (listed.code !== 0) return none;
    const names = [...new Set(listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter((n) => REMOTE_NAME.test(n)))];
    const branch = await currentBranch(git, dir);
    if (!names.length) return { kind: 'local', branch, remote: null, remotes: [] };
    const config = await readGitFile(git, dir, 'config');
    const urls = config === undefined ? new Map<string, string>() : parseRemoteUrls(config);
    const remotes = names.map((name) => ({ name, url: sanitizeRemoteUrl(urls.get(name) ?? '') }));
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null;
    return { kind: 'remote', branch, remote, remotes };
  } catch {
    // Sin git en el PATH del núcleo o forma negada por la guardia: no se puede leer, se trata como sin git.
    return none;
  }
}
