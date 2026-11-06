/**
 * Carpetas para la interfaz (F5): explorador (`GET /fs/list`), diálogo nativo de Windows (`POST /fs/pick-folder`) e
 * inspección de una carpeta antes de registrarla como proyecto (`POST /projects/inspect`).
 * Plan: docs/plan/F5-INTERFAZ.md §3.
 */
import { spawn } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { idSchema, redactSecrets, type FolderInspection, type FsListResponse } from '../../shared/index.ts';
import { branchSchema, isInside, physicalPath } from '../workspace/index.ts';

/** Tope de entradas de una carpeta en `GET /fs/list`. */
export const MAX_FS_ENTRIES = 2000;
/** Tope de lectura de `package.json`, `pyproject.toml` y demás al inspeccionar. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

export type FolderErrorCode = 'invalid' | 'not_found' | 'unsupported' | 'failed';
export class FolderError extends Error {
  override readonly name = 'FolderError';
  readonly code: FolderErrorCode;
  constructor(code: FolderErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface FsEnv {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

type FsEntry = FsListResponse['entries'][number];

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Ruta absoluta normalizada (`C:/dev//x/` → `C:\dev\x`). En Windows solo rutas con unidad (`C:\…`). Rechaza rutas
 * relativas (se resolverían contra el cwd del núcleo) y caracteres nulos.
 */
export function normalizeFolderPath(raw: string, platform: NodeJS.Platform = process.platform): string {
  const p = raw.trim();
  if (p === '' || p.includes('\0')) throw new FolderError('invalid', 'Ruta vacía o no válida');
  const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || /^[A-Za-z]:$/.test(p) : p.startsWith('/');
  if (!absolute) throw new FolderError('invalid', platform === 'win32' ? 'La ruta debe ser absoluta, con unidad (C:\\…)' : 'La ruta debe ser absoluta');
  const api = pathApi(platform);
  let out = api.resolve(platform === 'win32' && /^[A-Za-z]:$/.test(p) ? `${p}\\` : p);
  if (platform === 'win32') out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Repositorio git: tiene `.git` (carpeta en la copia principal; archivo en un worktree enlazado). */
export function isGitRepo(dir: string): Promise<boolean> {
  return exists(join(dir, '.git'));
}

// Archivos y carpetas de sistema que el explorador no muestra (Node no lee los atributos de Windows: se reconocen por
// nombre). Incluye las uniones heredadas del perfil («Mis documentos», «Datos de programa»…), ocultas y sin permiso
// de lectura.
const HIDDEN_NAMES = new Set(
  [
    '$recycle.bin',
    'system volume information',
    'config.msi',
    'recovery',
    'msocache',
    'documents and settings',
    'pagefile.sys',
    'hiberfil.sys',
    'swapfile.sys',
    'dumpstack.log',
    'dumpstack.log.tmp',
    'bootmgr',
    'bootnxt',
    'desktop.ini',
    'thumbs.db',
    '.git',
    'appdata',
    'application data',
    'cookies',
    'local settings',
    'my documents',
    'nethood',
    'printhood',
    'recent',
    'sendto',
    'start menu',
    'templates',
    'all users',
    'default user',
    'configuración local',
    'datos de programa',
    'mis documentos',
    'entorno de red',
    'impresoras',
    'reciente',
    'menú inicio',
    'plantillas',
  ].map((n) => n.normalize('NFC')),
);

/** ¿Es un archivo o carpeta de sistema que no se muestra? */
export function isSystemEntry(name: string): boolean {
  const n = name.normalize('NFC').toLowerCase();
  return HIDDEN_NAMES.has(n) || n.startsWith('$') || n.startsWith('~$') || /^ntuser\./.test(n);
}

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name));
}

function fsErrorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
}

async function requireDir(dir: string): Promise<void> {
  let st;
  try {
    st = await stat(dir);
  } catch (err) {
    const code = fsErrorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FolderError('not_found', 'La carpeta no existe');
    if (code === 'EACCES' || code === 'EPERM') throw new FolderError('invalid', 'Sin permiso para leer la carpeta');
    throw new FolderError('invalid', 'No se pudo leer la carpeta');
  }
  if (!st.isDirectory()) throw new FolderError('invalid', 'La ruta no es una carpeta');
}

/** Contenido de una carpeta: carpetas primero, sin archivos de sistema, con `isGitRepo` y un tope de entradas. */
export async function listFolder(raw: string, opts: FsEnv & { maxEntries?: number } = {}): Promise<FsListResponse> {
  const platform = opts.platform ?? process.platform;
  const dir = normalizeFolderPath(raw, platform);
  await requireDir(dir);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = fsErrorCode(err);
    throw new FolderError('invalid', code === 'EACCES' || code === 'EPERM' ? 'Sin permiso para leer la carpeta' : 'No se pudo leer la carpeta');
  }
  const api = pathApi(platform);
  const visible = dirents.filter((d) => !isSystemEntry(d.name));
  const typed = await Promise.all(
    visible.map(async (d): Promise<{ name: string; path: string; isDir: boolean } | undefined> => {
      const path = api.join(dir, d.name);
      if (d.isDirectory()) return { name: d.name, path, isDir: true };
      if (d.isSymbolicLink()) {
        // Enlaces y uniones (junctions): se muestran como lo que apuntan; rotos, no se muestran.
        try {
          return { name: d.name, path, isDir: (await stat(path)).isDirectory() };
        } catch {
          return undefined;
        }
      }
      return d.isFile() ? { name: d.name, path, isDir: false } : undefined;
    }),
  );
  const sorted = sortEntries(typed.filter((e): e is NonNullable<typeof e> => e !== undefined).map((e) => ({ ...e, isGitRepo: false })));
  const entries = sorted.slice(0, opts.maxEntries ?? MAX_FS_ENTRIES);
  await Promise.all(entries.map(async (e) => {
    if (e.isDir) e.isGitRepo = await isGitRepo(e.path);
  }));
  const parent = api.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}

/** Escritorio real (con la copia de seguridad de OneDrive suele estar en `<OneDrive>\Escritorio`). */
async function desktopDir(home: string, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const bases = [env.OneDriveCommercial, env.OneDrive, env.OneDriveConsumer, home].filter((b): b is string => Boolean(b?.trim()));
  for (const base of [...new Set(bases)]) {
    for (const name of ['Escritorio', 'Desktop']) {
      const candidate = win32.join(base, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Una unidad que no responde (red desconectada) no bloquea la lista. */
function existsWithin(p: string, ms: number): Promise<boolean> {
  return Promise.race([exists(p), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
}

/**
 * Raíces del explorador (`GET /fs/list` sin `path`): en Windows `C:\dev`, el Escritorio y el perfil, y después las
 * unidades que existen (`C:\`, `D:\`…). Fuera de Windows (desarrollo), el perfil y `/`.
 */
export async function listRoots(opts: FsEnv = {}): Promise<FsListResponse> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const candidates: { name: string; path: string }[] = [];
  if (platform === 'win32') {
    candidates.push({ name: 'C:\\dev', path: 'C:\\dev' });
    const desktop = await desktopDir(home, env);
    if (desktop) candidates.push({ name: 'Escritorio', path: desktop });
    candidates.push({ name: 'Perfil', path: home });
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const drives = await Promise.all(letters.map(async (l) => ((await existsWithin(`${l}:\\`, 1500)) ? `${l}:\\` : undefined)));
    for (const d of drives) if (d) candidates.push({ name: d.slice(0, 2), path: d });
  } else {
    candidates.push({ name: 'Perfil', path: home }, { name: '/', path: '/' });
  }
  const seen = new Set<string>();
  const entries: FsEntry[] = [];
  for (const c of candidates) {
    const key = platform === 'win32' ? c.path.toLowerCase() : c.path;
    if (seen.has(key) || !(await exists(c.path))) continue;
    seen.add(key);
    entries.push({ name: c.name, path: c.path, isDir: true, isGitRepo: await isGitRepo(c.path) });
  }
  return { path: '', parent: null, entries };
}

// ─────────────────────────────────────────────────────────────── inspección de una carpeta

const DEFAULT_GATE_TIMEOUT_MS = 30 * 60_000;
/** Orden de preferencia de los scripts de `package.json` para el gate. */
export const GATE_SCRIPTS = ['check', 'gate', 'test'] as const;

export type GateCommand = { command: string; args: string[] };

async function readSmall(p: string): Promise<string | undefined> {
  try {
    const st = await stat(p);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return undefined;
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

const packageJsonSchema = z.object({ scripts: z.record(z.string(), z.unknown()).optional() });

/**
 * Gate deducido de la carpeta: el primer script de `package.json` entre `check`, `gate` y `test` (`npm run -s <script>`;
 * se ignora el `test` de relleno de `npm init`), o pytest si hay `pytest.ini`, `[tool.pytest…]`/pytest en
 * `pyproject.toml` o `[tool:pytest]` en `setup.cfg` (`python -m pytest -q`). `null` si no hay ninguno.
 */
export async function deduceGate(dir: string): Promise<{ gate: GateCommand[] | null; warnings: string[] }> {
  const warnings: string[] = [];
  const pkgText = await readSmall(join(dir, 'package.json'));
  if (pkgText !== undefined) {
    let pkg: z.infer<typeof packageJsonSchema> | undefined;
    try {
      const parsed = packageJsonSchema.safeParse(JSON.parse(pkgText));
      pkg = parsed.success ? parsed.data : undefined;
    } catch {
      pkg = undefined;
    }
    if (!pkg) warnings.push('package.json no es JSON válido: no se pudo deducir el gate de sus scripts');
    for (const name of GATE_SCRIPTS) {
      const script = pkg?.scripts?.[name];
      if (typeof script !== 'string' || script.trim() === '') continue;
      if (name === 'test' && /no test specified/i.test(script)) continue;
      return { gate: [{ command: 'npm', args: ['run', '-s', name] }], warnings };
    }
  }
  const pyproject = await readSmall(join(dir, 'pyproject.toml'));
  const setupCfg = await readSmall(join(dir, 'setup.cfg'));
  if ((await exists(join(dir, 'pytest.ini'))) || /pytest/i.test(pyproject ?? '') || /\[tool:pytest\]/.test(setupCfg ?? '')) {
    return { gate: [{ command: 'python', args: ['-m', 'pytest', '-q'] }], warnings };
  }
  return { gate: null, warnings };
}

/** Gate de la inspección con el plazo que se guarda en el proyecto (30 min). */
export function gateForWorkspace(gate: readonly GateCommand[]): { command: string; args: string[]; timeoutMs: number }[] {
  return gate.map((g) => ({ command: g.command, args: [...g.args], timeoutMs: DEFAULT_GATE_TIMEOUT_MS }));
}

/**
 * El repositorio tiene al menos un commit: HEAD separado (apunta a un commit) o la rama de HEAD existe como ref suelta
 * o en `packed-refs` (también en worktrees enlazados, vía `commondir`). Un `git init` recién hecho no tiene ninguno y
 * no admite worktrees.
 */
export async function hasCommits(dir: string): Promise<boolean> {
  const dotGit = join(dir, '.git');
  try {
    let gitDir = dotGit;
    if ((await stat(dotGit)).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec((await readSmall(dotGit)) ?? '');
      if (!m?.[1]) return false;
      gitDir = resolve(dir, m[1]);
    }
    const head = ((await readSmall(join(gitDir, 'HEAD'))) ?? '').trim();
    const ref = /^ref:\s*(refs\/heads\/.+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40,64}$/i.test(head);
    const common = ((await readSmall(join(gitDir, 'commondir'))) ?? '').trim();
    const commonDir = common ? resolve(gitDir, common) : gitDir;
    if (await exists(join(commonDir, ...ref.split('/')))) return true;
    const packed = (await readSmall(join(commonDir, 'packed-refs'))) ?? '';
    return packed.split(/\r?\n/).some((line) => line.trim().endsWith(` ${ref}`));
  } catch {
    return false;
  }
}

/** Rama actual leyendo `.git/HEAD` (también en worktrees enlazados). `undefined` si HEAD está separado o no se lee. */
export async function currentBranch(dir: string): Promise<string | undefined> {
  const dotGit = join(dir, '.git');
  let gitDir = dotGit;
  try {
    if ((await stat(dotGit)).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec((await readSmall(dotGit)) ?? '');
      if (!m?.[1]) return undefined;
      gitDir = resolve(dir, m[1]);
    }
    const head = ((await readSmall(join(gitDir, 'HEAD'))) ?? '').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
    return ref !== undefined && branchSchema.safeParse(ref).success ? ref : undefined;
  } catch {
    return undefined;
  }
}

/** Id de proyecto (`idSchema`) a partir de un nombre: sin tildes, en minúsculas, con guiones. */
export function slugifyProjectId(name: string): string {
  let s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (s.length < 2) s = s ? `${s}-proyecto` : 'proyecto';
  return idSchema.parse(s);
}

/** Id libre: el del nombre o, si ya existe, con sufijo `-2`, `-3`… */
export function suggestProjectId(name: string, taken: ReadonlySet<string>): string {
  const base = slugifyProjectId(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

export interface KnownProject {
  id: string;
  repoPath: string;
}

export interface FolderReport {
  inspection: FolderInspection;
  /** Rama actual (`undefined`: HEAD separado o sin git). */
  branch: string | undefined;
  /** El repositorio tiene al menos un commit (sin commits no hay worktrees: modo local). */
  hasCommits: boolean;
  /** Proyecto ya registrado en esta misma carpeta. */
  registeredAs: string | undefined;
}

/**
 * Lo que se deduce de una carpeta para registrarla: id y nombre (de la carpeta), git, gate, enlaces y avisos. Lanza
 * `FolderError` si la ruta no es absoluta, no existe o no es una carpeta.
 */
export async function inspectFolder(raw: string, opts: FsEnv & { projects?: readonly KnownProject[] } = {}): Promise<FolderReport> {
  const platform = opts.platform ?? process.platform;
  const dir = normalizeFolderPath(raw, platform);
  await requireDir(dir);
  const projects = opts.projects ?? [];
  const folderName = pathApi(platform).basename(dir) || dir.replace(/[\\/:]+/g, '') || 'proyecto';
  // También por la carpeta física: una junction hacia una carpeta ya registrada es la misma carpeta.
  const same = (a: string, b: string) => isInside(a, b, platform) && isInside(b, a, platform);
  const physical = (p: string) => (platform === process.platform ? physicalPath(p) : p);
  const registeredAs = projects.find((p) => {
    try {
      return same(p.repoPath, dir) || same(physical(p.repoPath), physical(dir));
    } catch {
      return false;
    }
  })?.id;
  const base = slugifyProjectId(folderName);
  const suggestedId = suggestProjectId(folderName, new Set(projects.map((p) => p.id)));
  const git = await isGitRepo(dir);
  const { gate, warnings } = await deduceGate(dir);
  const links = (await exists(join(dir, 'node_modules'))) ? ['node_modules'] : [];
  const branch = git ? await currentBranch(dir) : undefined;
  const committed = git ? await hasCommits(dir) : false;

  if (registeredAs) warnings.push(`La carpeta ya está registrada como el proyecto ${registeredAs}`);
  if (suggestedId !== base) warnings.push(`Ya existe un proyecto con id ${base}: se sugiere ${suggestedId}`);
  if (!git) warnings.push('No es un repositorio git: se trabajará en local, directamente en la carpeta (sin worktrees ni commits)');
  else if (!committed) warnings.push('El repositorio git aún no tiene commits: se trabajará en local, directamente en la carpeta (sin worktrees ni commits)');
  else if (!branch) warnings.push('HEAD separado: se usará main como rama base');
  if (!gate) {
    warnings.push(
      `No se encontró una verificación (gate): se trabajará en local, directamente en la carpeta. Para usar worktrees por tarea, agrega un script ${GATE_SCRIPTS.join(', ')} en package.json o pruebas con pytest`,
    );
  }
  return {
    inspection: { path: dir, suggestedId, suggestedName: folderName, isGitRepo: git, gate, links, warnings },
    branch,
    hasCommits: committed,
    registeredAs,
  };
}

// ─────────────────────────────────────────────────────────────── diálogo de Windows

/** PowerShell `-EncodedCommand`: el script en UTF-16LE y base64 (sin comillas ni escapes de shell). */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Script del diálogo `FolderBrowserDialog` (ventana dueña TopMost para que aparezca delante del navegador). */
export function folderPickerScript(description = 'Elige la carpeta del proyecto'): string {
  const text = description.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${text}'`,
    '$dialog.ShowNewFolderButton = $true',
    "if (Test-Path -LiteralPath 'C:\\dev') { $dialog.SelectedPath = 'C:\\dev' }",
    '$result = $dialog.ShowDialog($owner)',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    '$owner.Dispose()',
  ].join('\n');
}

export type SpawnFn = typeof spawn;

export interface FolderPickerOptions {
  powershellPath: string;
  platform?: NodeJS.Platform;
  /** Plazo para que el usuario elija (10 min por defecto); al vencer se cierra el diálogo y se responde `null`. */
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

/**
 * Selector de carpeta nativo (para la web: Electron usa el suyo). PowerShell con `-EncodedCommand`, sin shell, con
 * `-STA` (lo exige el diálogo). Sin `windowsHide`: ocultaría también el diálogo; la consola la oculta
 * `-WindowStyle Hidden`. Un solo diálogo a la vez: las llamadas mientras está abierto esperan la misma respuesta.
 */
export function createFolderPicker(opts: FolderPickerOptions): () => Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const spawnFn = opts.spawnFn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  let open: Promise<string | null> | undefined;

  const run = () =>
    new Promise<string | null>((resolvePick, reject) => {
      if (platform !== 'win32') {
        reject(new FolderError('unsupported', 'El diálogo de carpetas solo existe en Windows'));
        return;
      }
      const args = ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(folderPickerScript())];
      let child;
      try {
        child = spawnFn(opts.powershellPath, args, { shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        reject(new FolderError('failed', 'No se pudo abrir el diálogo de carpetas (PowerShell)'));
        return;
      }
      let out = '';
      let err = '';
      let timedOut = false;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (out.length < 64 * 1024) out += d;
      });
      child.stderr?.on('data', (d: string) => {
        if (err.length < 4096) err += d;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      timer.unref();
      child.once('error', () => {
        clearTimeout(timer);
        reject(new FolderError('failed', 'No se pudo abrir el diálogo de carpetas (PowerShell)'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolvePick(null);
          return;
        }
        if (code !== 0) {
          const detail = redactSecrets(err.trim().split(/\r?\n/)[0] ?? '').slice(0, 200);
          reject(new FolderError('failed', `El diálogo de carpetas falló${detail ? `: ${detail}` : ''}`));
          return;
        }
        const picked = out.replace(/^\uFEFF/, '').trim();
        if (picked === '') {
          resolvePick(null);
          return;
        }
        try {
          resolvePick(normalizeFolderPath(picked, platform));
        } catch {
          resolvePick(null);
        }
      });
    });

  return () => {
    open ??= run().finally(() => {
      open = undefined;
    });
    return open;
  };
}
