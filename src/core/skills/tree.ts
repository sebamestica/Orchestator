import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, opendir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { renameWithRetry } from '../memory/safe-fs.ts';

/**
 * Recorrido y huellas de un árbol de skill. Solo lee: nunca ejecuta ni importa archivos.
 * No sigue enlaces simbólicos ni junctions (en Windows `lstat` los reporta como enlace).
 */
export interface TreeLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Entradas totales (archivos + carpetas + enlaces + lo demás). */
  maxEntries: number;
  /** Segmentos de ruta como máximo (`a/b/c.md` = 3). */
  maxDepth: number;
}

export interface WalkOptions {
  /** Nombres que se omiten (por defecto `.git`). */
  skip?: ReadonlySet<string>;
  /**
   * Seguir la raíz si es un enlace o junction. Solo para un origen elegido por el usuario o una
   * skill instalada que se lee para exportarla; nunca para la cuarentena ni la raíz de instalación.
   */
  followRoot?: boolean;
}

export interface WalkResult {
  /** Rutas relativas con `/`, ordenadas. */
  files: { path: string; size: number }[];
  dirs: string[];
  /** Entradas omitidas a propósito (p. ej. `.git`, que trae hooks ejecutables). */
  skipped: string[];
  /** Enlaces, tipos especiales o límites superados. Si hay alguno, el árbol no es aceptable. */
  problems: string[];
  totalBytes: number;
}

export const SKIPPED_NAMES: ReadonlySet<string> = new Set(['.git']);

/**
 * Recorre `root` con `lstat`. La raíz también se comprueba: si es un enlace o junction (y no se
 * pidió `followRoot`), el resultado lleva el problema y ningún archivo. Los límites de archivos,
 * bytes, entradas y profundidad se aplican mientras se lee cada carpeta (con `opendir`, sin cargar
 * listados enteros) y lanzan `TreeLimitError` en cuanto se superan.
 */
export async function walkTree(root: string, limits: TreeLimits, opts: WalkOptions = {}): Promise<WalkResult> {
  const skip = opts.skip ?? SKIPPED_NAMES;
  const out: WalkResult = { files: [], dirs: [], skipped: [], problems: [], totalBytes: 0 };
  const rootSt = opts.followRoot ? await stat(root) : await lstat(root);
  if (rootSt.isSymbolicLink()) { out.problems.push('(raíz): es un enlace simbólico o junction'); return out; }
  if (!rootSt.isDirectory()) { out.problems.push('(raíz): no es una carpeta'); return out; }
  let entriesSeen = 0;
  const visit = async (rel: string, depth: number): Promise<void> => {
    const names: string[] = [];
    for await (const e of await opendir(rel ? join(root, rel) : root)) {
      if (++entriesSeen > limits.maxEntries) throw new TreeLimitError(`más de ${limits.maxEntries} entradas`);
      names.push(e.name);
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (skip.has(name)) { out.skipped.push(relPath); continue; }
      if (depth > limits.maxDepth) throw new TreeLimitError(`profundidad ${depth} supera el máximo (${limits.maxDepth}) en ${relPath}`);
      const st = await lstat(join(root, relPath));
      if (st.isSymbolicLink()) { out.problems.push(`${relPath}: es un enlace simbólico o junction`); continue; }
      if (st.isDirectory()) {
        out.dirs.push(relPath);
        await visit(relPath, depth + 1);
        continue;
      }
      if (!st.isFile()) { out.problems.push(`${relPath}: tipo de archivo no permitido`); continue; }
      if (st.nlink > 1) out.problems.push(`${relPath}: tiene ${st.nlink} enlaces duros`);
      if (st.size > limits.maxFileBytes) out.problems.push(`${relPath}: ${st.size} bytes supera el máximo por archivo (${limits.maxFileBytes})`);
      out.files.push({ path: relPath, size: st.size });
      out.totalBytes += st.size;
      if (out.files.length > limits.maxFiles) throw new TreeLimitError(`más de ${limits.maxFiles} archivos`);
      if (out.totalBytes > limits.maxTotalBytes) throw new TreeLimitError(`más de ${limits.maxTotalBytes} bytes`);
    }
  };
  await visit('', 1);
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export class TreeLimitError extends Error {
  override readonly name = 'TreeLimitError';
}

/** El árbol cambió entre el recorrido y su uso (un componente pasó a ser enlace, cambió de tipo…). */
export class TreeChangedError extends Error {
  override readonly name = 'TreeChangedError';
}

/** Igualdad de rutas reales (en Windows, sin distinguir mayúsculas). */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Comprueba, justo antes de usarla, que `rel` sigue siendo del tipo esperado y que su ruta real está bajo `realRoot` sin enlaces intermedios. */
async function recheck(realRoot: string, root: string, rel: string, kind: 'file' | 'dir'): Promise<string> {
  const abs = join(root, ...rel.split('/'));
  const st = await lstat(abs);
  if (st.isSymbolicLink()) throw new TreeChangedError(`${rel}: se convirtió en enlace o junction después del recorrido`);
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) throw new TreeChangedError(`${rel}: cambió de tipo después del recorrido`);
  const real = await realpath(abs);
  if (!samePath(real, join(realRoot, ...rel.split('/')))) throw new TreeChangedError(`${rel}: su ruta real (${real}) queda fuera del origen: hay un enlace en una carpeta intermedia`);
  return abs;
}

export type ScriptReason = 'extensión' | 'shebang' | 'binario' | 'manifiesto';

export interface FileInfo {
  path: string;
  size: number;
  sha256: string;
  /** Motivos por los que el archivo podría ejecutarse (en la revisión se muestran como scripts). */
  script?: ScriptReason[];
}

/** Extensiones que Windows, un intérprete o un cargador pueden ejecutar o cargar como código. */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh', '.command',
  '.ps1', '.psm1', '.psd1', '.ps1xml', '.bat', '.cmd', '.com', '.exe', '.dll', '.sys', '.msi', '.msix', '.appx', '.scr', '.cpl', '.lnk', '.url', '.reg', '.inf', '.hta', '.chm',
  '.vbs', '.vbe', '.wsf', '.wsh', '.js', '.jse', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.py', '.pyw', '.pyc', '.pyz', '.rb', '.pl', '.pm', '.php', '.lua', '.tcl', '.r', '.jl', '.groovy', '.kts',
  '.jar', '.class', '.so', '.dylib', '.node', '.wasm', '.applescript', '.scpt', '.xlam', '.xlsm', '.docm', '.pptm',
]);
const MANIFESTS: ReadonlySet<string> = new Set(['package.json', 'makefile', 'justfile', 'taskfile.yml', 'pyproject.toml', 'setup.py', 'cargo.toml']);

function binaryMagic(head: Buffer): boolean {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true; // MZ (PE de Windows)
  if (head.length < 4) return false;
  const m = head.readUInt32BE(0);
  return m === 0x7f454c46 /* ELF */ || m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe || m === 0xcafebabe /* Mach-O / Java */;
}

/** SHA-256 de un archivo y sus primeros bytes (para shebang y cabeceras binarias). */
async function hashFile(path: string): Promise<{ sha256: string; head: Buffer }> {
  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    if (head.length < 4) head = Buffer.concat([head, buf.subarray(0, 4 - head.length)]);
    hash.update(buf);
  }
  return { sha256: hash.digest('hex'), head };
}

export function scriptReasons(path: string, head: Buffer): ScriptReason[] {
  const reasons: ScriptReason[] = [];
  const base = path.split('/').at(-1) ?? path;
  if (EXECUTABLE_EXTENSIONS.has(extname(base).toLowerCase())) reasons.push('extensión');
  const shebangAt = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0; // con BOM
  if (head[shebangAt] === 0x23 && head[shebangAt + 1] === 0x21) reasons.push('shebang');
  if (binaryMagic(head)) reasons.push('binario');
  if (MANIFESTS.has(base.toLowerCase())) reasons.push('manifiesto');
  return reasons;
}

export async function inspectFiles(root: string, files: readonly { path: string; size: number }[]): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  for (const f of files) {
    const { sha256, head } = await hashFile(join(root, f.path));
    const info: FileInfo = { path: f.path, size: f.size, sha256 };
    const reasons = scriptReasons(f.path, head);
    if (reasons.length) info.script = reasons;
    out.push(info);
  }
  return out;
}

/**
 * Hash del árbol: SHA-256 del manifiesto `"<sha256>  <ruta>\n"` (formato de `sha256sum`) de cada
 * archivo, ordenado por ruta relativa con `/`. Las carpetas vacías no cuentan.
 */
export function treeHash(files: readonly { path: string; sha256: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = sorted.map((f) => `${f.sha256}  ${f.path}\n`).join('');
  return `sha256:${createHash('sha256').update(manifest, 'utf8').digest('hex')}`;
}

export async function sha256File(path: string): Promise<string> {
  return (await hashFile(path)).sha256;
}

export interface LicenseInfo {
  /** Campo `license` del frontmatter. */
  declared?: string;
  /** Archivos de licencia en la raíz de la skill. */
  files: string[];
  /** Licencia reconocida en el primer archivo (heurística por texto). */
  detected?: string;
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|unlicense)(?:[-._][\w.-]*)?$/i;
const LICENSE_PATTERNS: readonly [RegExp, string][] = [
  [/Apache License,?\s+Version 2\.0/i, 'Apache-2.0'],
  [/^\s*MIT License|Permission is hereby granted, free of charge/im, 'MIT'],
  [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, 'AGPL-3.0'],
  [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i, 'LGPL-3.0'],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, 'GPL-3.0'],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, 'GPL-2.0'],
  [/Mozilla Public License,?\s+(?:Version|v\.)\s*2\.0/i, 'MPL-2.0'],
  [/Redistribution and use in source and binary forms/i, 'BSD'],
  [/This is free and unencumbered software released into the public domain/i, 'Unlicense'],
  [/Creative Commons Attribution(?:[- ]ShareAlike)? 4\.0/i, 'CC-BY-4.0'],
  [/ISC License|Permission to use, copy, modify, and\/or distribute this software/i, 'ISC'],
];

export async function detectLicense(root: string, files: readonly { path: string }[], declared?: string): Promise<LicenseInfo> {
  const found = files.map((f) => f.path).filter((p) => !p.includes('/') && LICENSE_FILE.test(p));
  const info: LicenseInfo = { files: found };
  if (declared !== undefined) info.declared = declared;
  const first = found[0];
  if (first) {
    const text = (await readFile(join(root, first), 'utf8')).slice(0, 20_000);
    const hit = LICENSE_PATTERNS.find(([re]) => re.test(text));
    if (hit) info.detected = hit[1];
  }
  return info;
}

/**
 * Copia los archivos y carpetas ya validados por `walkTree`, sin sobrescribir (`COPYFILE_EXCL`).
 * Justo antes de cada `mkdir`/`copyFile` vuelve a comprobar el origen (`lstat` y `realpath`): si un
 * componente pasó a ser enlace o junction, o cambió de tipo, lanza `TreeChangedError`.
 *
 * Riesgo residual: Node no ofrece en Windows abrir relativo a un handle (`openat`/`O_NOFOLLOW`), así
 * que entre esa comprobación y `copyFile` queda una ventana muy corta. Por eso quien instala vuelve a
 * calcular el hash sobre la copia (su carpeta privada) y no sobre el origen.
 */
export async function copyTree(src: string, dest: string, walk: Pick<WalkResult, 'files' | 'dirs'>, opts: { followRoot?: boolean } = {}): Promise<void> {
  if (!opts.followRoot && (await lstat(src)).isSymbolicLink()) throw new TreeChangedError(`${src}: la raíz es un enlace o junction`);
  const realRoot = await realpath(src);
  await mkdir(dest, { recursive: true });
  for (const d of walk.dirs) {
    await recheck(realRoot, src, d, 'dir');
    await mkdir(join(dest, d), { recursive: true });
  }
  for (const f of walk.files) {
    const from = await recheck(realRoot, src, f.path, 'file');
    await copyFile(from, join(dest, f.path), fsConstants.COPYFILE_EXCL);
  }
}

/** Mueve una carpeta (con reintentos si Windows la tiene abierta); entre volúmenes, copia y borra. */
export async function moveDir(src: string, dest: string, limits: TreeLimits): Promise<void> {
  try {
    await renameWithRetry(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const walk = await walkTree(src, limits, { skip: new Set() });
    if (walk.problems.length) throw new Error(`no se puede mover ${src}: ${walk.problems.join('; ')}`);
    await copyTree(src, dest, walk);
    await rm(src, { recursive: true, force: true });
  }
}
