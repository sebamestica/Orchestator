import { readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { IntegrationResult, TaskBrief, Workspace, WorkspaceManager } from '../../shared/index.ts';
import { PREFIXED_SECRET_PATTERNS, redactSecrets } from '../../shared/index.ts';
import { normalizeOwnedPath, pathsOverlap, type ExecuteResult } from '../orchestrator/index.ts';
import { createGitRunner, DEFAULT_INTEGRATION_BRANCH, GitError, isInside, type GitRunner } from '../workspace/index.ts';

/** Carpeta de trabajo del orquestador en cada worktree (BRIEF, HANDOFF, último mensaje): nunca se confirma. */
export const ORQ_SCRATCH = '.orq';

/**
 * Los commits de la flota van a nombre del usuario: la identidad git que tenga configurada (`user.name` y
 * `user.email` del repositorio o globales). Nunca se inventa un autor ni se añaden trailers `Co-Authored-By`.
 */
export const NO_IDENTITY_MESSAGE =
  'No hay identidad git configurada (user.name y user.email): Berland confirma el trabajo a tu nombre y nunca inventa un autor. Configúrala con «git config --global user.name "Tu nombre"» y «git config --global user.email tu@correo».';

export class GitIdentityError extends Error {
  override readonly name = 'GitIdentityError';
  constructor() {
    super(NO_IDENTITY_MESSAGE);
  }
}

/** git rechazó el commit por falta de identidad (mensajes de git en inglés, con `LC_ALL=C`). */
export function isMissingIdentity(stderr: string): boolean {
  return /Author identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email address/i.test(stderr);
}

export class OwnedPathsError extends Error {
  override readonly name = 'OwnedPathsError';
  readonly taskId: string;
  readonly files: readonly string[];
  constructor(taskId: string, files: readonly string[]) {
    super(`La tarea ${taskId} cambió archivos fuera de sus rutas propias (ownedPaths): ${files.slice(0, 20).join(', ')}${files.length > 20 ? ` y ${files.length - 20} más` : ''}`);
    this.taskId = taskId;
    this.files = files;
  }
}

/** La tarea escribió una clave o un token: Berland no lo confirma ni lo integra. Nombra los archivos, nunca el valor. */
export class SecretInWorkError extends Error {
  override readonly name = 'SecretInWorkError';
  readonly taskId: string;
  readonly files: readonly string[];
  /** El secreto ya está en un commit del propio agente: borrar el archivo no basta, hay que rehacer la rama. */
  readonly committed: boolean;
  constructor(taskId: string, files: readonly string[], committed: boolean) {
    super(
      `La tarea ${taskId} escribió lo que parece una clave o un token en: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ` y ${files.length - 20} más` : ''}. Berland no lo confirma` +
        (committed ? '. Ya está en un commit de la rama de la tarea: hay que rehacer la rama, no basta con borrar el archivo' : ''),
    );
    this.taskId = taskId;
    this.files = files;
    this.committed = committed;
  }
}

/** Archivos nuevos más grandes que esto no se revisan (datos o binarios); los parches los corta el GitRunner (~1 MB). */
const SCAN_FILE_LIMIT = 1_000_000;

/** Un secreto conocido (8 caracteres o más) o una clave con prefijo propio. El patrón genérico no bloquea. */
function hasSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => s.length >= 8 && text.includes(s)) || PREFIXED_SECRET_PATTERNS.some((p) => text.search(p) >= 0);
}

/** Archivos de un parche (`--no-prefix`) con alguna línea agregada que tenga un secreto. */
function patchFilesWithSecrets(patch: string, secrets: readonly string[]): string[] {
  const files = new Set<string>();
  let file = '';
  let prev = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ') && prev.startsWith('--- ')) file = line.slice(4).trim();
    else if (line.startsWith('+') && hasSecret(line.slice(1), secrets)) files.add(file);
    prev = line;
  }
  return [...files];
}

/** Archivos sin seguimiento (`??`) de `git status --porcelain=v1 -z`. */
function untrackedOf(status: string): string[] {
  return status.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3));
}

async function fileHasSecret(path: string, secrets: readonly string[]): Promise<boolean> {
  try {
    if ((await stat(path)).size > SCAN_FILE_LIMIT) return false;
    return hasSecret(await readFile(path, 'utf8'), secrets);
  } catch {
    return false;
  }
}

/**
 * Busca secretos en lo que la tarea agrega: lo pendiente (diff contra HEAD y archivos nuevos) y lo que el agente ya
 * confirmó desde `baseRef`, commit por commit (un secreto agregado y luego borrado sigue en la historia).
 */
async function secretsInWork(git: GitRunner, worktreePath: string, status: string, baseRef: string, secrets: readonly string[]): Promise<{ files: string[]; committed: boolean }> {
  const patch = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', '-U0'];
  const history = await git(worktreePath, ['log', '-p', '--format=', ...patch, `${baseRef}..HEAD`]);
  const committed = patchFilesWithSecrets(history.stdout, secrets);
  const files = new Set([...committed, ...patchFilesWithSecrets((await git(worktreePath, ['diff', ...patch, 'HEAD'])).stdout, secrets)]);
  for (const f of untrackedOf(status)) if (!isScratch(f) && (await fileHasSecret(join(worktreePath, f), secrets))) files.add(f);
  return { files: [...files].filter((f) => !isScratch(f)), committed: committed.length > 0 };
}

/** Rutas de `git status --porcelain=v1 -z` (en renombres y copias, las dos). */
export function parsePorcelainZ(out: string): string[] {
  const tokens = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] ?? '';
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      const original = tokens[++i];
      if (original) files.push(original);
    }
  }
  return files;
}

/**
 * Rutas que hay que pasar a `git add -A` para dejar todo preparado: se omiten las que ya están preparadas y no
 * existen en la copia de trabajo (borrado preparado `D ` y origen de un renombre `R`/`C`), porque git las rechaza
 * con «pathspec did not match».
 */
export function pathsToAdd(out: string): string[] {
  const tokens = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] ?? '';
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    if (x === 'R' || x === 'C') i++; // el origen ya está preparado
    if (x === 'D' && y === ' ') continue;
    files.push(entry.slice(3));
  }
  return files;
}

const isScratch = (file: string) => {
  const n = normalizeOwnedPath(file);
  return n === ORQ_SCRATCH || n.startsWith(`${ORQ_SCRATCH}/`);
};

/** Archivos (sin la carpeta `.orq`) que no caen en ninguna ruta propia. */
export function outsideOwnedPaths(files: readonly string[], ownedPaths: readonly string[]): string[] {
  return [...new Set(files.map(normalizeOwnedPath))].filter((f) => f && !isScratch(f) && !ownedPaths.some((p) => pathsOverlap(p, f)));
}

/** El worktree ya no está en la rama de la tarea (`git checkout otra`): confirmar ahí movería una rama ajena. */
export class TaskBranchError extends Error {
  override readonly name = 'TaskBranchError';
  constructor(taskId: string, foreign: string, expected: string, visited = false) {
    const where = visited ? `pasó por la rama «${foreign}» (pudo moverla: las ramas son comunes a todo el repo)` : `trabaja en la rama «${foreign}», no en «${expected}»`;
    super(`La tarea ${taskId} ${where}: Berland no confirma ni integra ese trabajo. Revisa esa rama y descarta el intento.`);
  }
}

/**
 * Ramas locales, distintas de `branch`, a las que cambió el worktree (`git checkout otra`, `switch -C main`). El HEAD
 * de cada worktree tiene su propio reflog, así que el trabajo del usuario en su copia no cuenta. Un `checkout` a un
 * commit suelto (`HEAD~1`) no es una rama y tampoco cuenta.
 */
async function visitedBranches(git: GitRunner, worktreePath: string, branch: string): Promise<string[]> {
  // La guardia de git del núcleo no deja usar `reflog`: se lee el archivo del reflog del HEAD de este worktree.
  const logPath = (await git(worktreePath, ['rev-parse', '--git-path', 'logs/HEAD'])).stdout.trim();
  const log = await readFile(resolve(worktreePath, logPath), 'utf8').catch(() => '');
  const targets = new Set([...log.matchAll(/\tcheckout: moving from .+ to (.+)$/gm)].map((m) => (m[1] ?? '').trim()));
  targets.delete(branch);
  const visited: string[] = [];
  for (const target of targets) {
    // `main~1`, `HEAD^`, `v1:x` o `@{-1}` son commits, no ramas (y `rev-parse` los resolvería igual).
    if (!target || /[~^:\s]|@\{|\.\./.test(target)) continue;
    const ref = await git(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], { check: false });
    if (ref.code === 0) visited.push(target);
  }
  return visited;
}

export interface CommitResult {
  /** Archivos confirmados ahora (vacío si no había nada pendiente). */
  files: string[];
  commit?: string;
}

/** Archivos por llamada a `git add` (la línea de órdenes de Windows admite ~32 000 caracteres). */
const ADD_BATCH = 100;

/**
 * Comprueba que todo lo que cambió la tarea (sin confirmar y ya confirmado desde `baseRef`) está dentro de sus
 * `ownedPaths` y no trae claves (`secrets` conocidos o con prefijo propio), y confirma lo pendiente en la rama de la
 * tarea (`branch`). Lanza `OwnedPathsError` o `SecretInWorkError` si algo queda fuera o trae una clave, y
 * `TaskBranchError` si el worktree está o estuvo en otra rama (en todos los casos no confirma nada). Codex no puede
 * hacer commits en su sandbox y otros agentes lo olvidan.
 */
export async function commitTaskWork(git: GitRunner, worktreePath: string, task: TaskBrief, baseRef: string, branch: string, secrets: readonly string[] = []): Promise<CommitResult> {
  const current = (await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (current !== branch) throw new TaskBranchError(task.id, current, branch);
  const visited = await visitedBranches(git, worktreePath, branch);
  if (visited.length) throw new TaskBranchError(task.id, visited.join(', '), branch, true);
  const status = await git(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const pending = parsePorcelainZ(status.stdout).filter((f) => !isScratch(f));
  const committed = (await git(worktreePath, ['diff', '--name-only', '-z', `${baseRef}...HEAD`])).stdout.split('\0').filter(Boolean);
  const outside = outsideOwnedPaths([...pending, ...committed], task.ownedPaths);
  if (outside.length) throw new OwnedPathsError(task.id, outside);
  const leaked = await secretsInWork(git, worktreePath, status.stdout, baseRef, secrets);
  if (leaked.files.length) throw new SecretInWorkError(task.id, leaked.files, leaked.committed);
  if (pending.length === 0) return { files: [] };
  // Se agregan los archivos pendientes por nombre (sin `.orq`): un pathspec `:(exclude).orq` hace salir a
  // `git add` con 1 cuando `.orq` está en `.gitignore` (visto en vivo el 2026-11-04 en el repo del orquestador).
  // En tandas, para no pasar el límite de la línea de órdenes de Windows.
  const files = [...new Set(pathsToAdd(status.stdout).filter((f) => !isScratch(f)))];
  for (let i = 0; i < files.length; i += ADD_BATCH) {
    await git(worktreePath, ['add', '-A', '--', ...files.slice(i, i + ADD_BATCH)]);
  }
  const message = redactSecrets(`${task.id}: ${task.title}\n\nTrabajo de la tarea ${task.id}, confirmado por Berland.`);
  // Sin variables GIT_AUTHOR_*: git usa la identidad configurada del usuario. Si no hay, error claro y ningún commit.
  const commit = await git(worktreePath, ['commit', '-q', '-m', message], { check: false });
  if (commit.code !== 0) {
    if (isMissingIdentity(commit.stderr)) throw new GitIdentityError();
    throw new GitError(`git commit falló (código ${String(commit.code)}): ${redactSecrets(commit.stderr.trim()).slice(0, 400)}`, ['commit'], commit);
  }
  const head = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
  return { files: [...new Set(pending.map(normalizeOwnedPath))], commit: head };
}

export interface CommittingWorkspacesOptions {
  inner: WorkspaceManager;
  /** Rama desde la que se creó la rama de la tarea (por defecto `orq/integracion`): la de la configuración del worktree. */
  integrationBranch?: (projectId: string, workspace: Workspace) => string;
  git?: GitRunner;
  log?: (line: string) => void;
  /** Valores exactos de las claves que Berland entregó a los agentes (bóveda): si aparecen en el trabajo, no se confirma. */
  secrets?: () => readonly string[];
}

/** Gestor interno que distingue el modo local (lo implementa `ProjectWorktrees`). */
interface LocalAware {
  isLocal(workspace: Workspace): boolean;
  exclusiveKey(projectId: string): string | undefined;
  agentEnv?(workspace: Workspace): Readonly<Record<string, string>> | undefined;
  /** Lo que cambió en la carpeta local desde que empezó la tarea; `undefined` si no se sabe. */
  changedSince?(workspace: Workspace): Promise<string[] | undefined>;
}

function isLocalAware(inner: WorkspaceManager): inner is WorkspaceManager & LocalAware {
  const m = inner as Partial<LocalAware>;
  return typeof m.isLocal === 'function' && typeof m.exclusiveKey === 'function';
}

/** Máximo de archivos que se listan en el resumen del modo local. */
const LOCAL_SUMMARY_FILES = 200;

/**
 * Decorador de `WorkspaceManager`: antes de integrar comprueba las rutas propias y confirma el trabajo del agente
 * (ver `commitTaskWork`); si algo queda fuera, `integrate` no integra y devuelve el motivo, y la tarea vuelve al
 * autor. `prepare` hace lo mismo antes de la revisión (`diffSummaryStep`). Al quitar un worktree borra
 * primero su `.orq` si no está versionada, para que `remove` no lo tome por trabajo sin confirmar.
 *
 * En **modo local** (carpeta del usuario, sin worktree) no hay nada que confirmar: no se ejecuta ningún git que
 * escriba. El resumen para el revisor junta los archivos que informó el agente con lo que cambió de verdad en la
 * carpeta (foto antes y después, ver `LocalWorkspaces.changedSince`), y le señala los que caen fuera de las rutas
 * propias. Si siguen así al integrar, `integrate` no da la tarea por buena: vuelve al autor con la lista (en la
 * carpeta del usuario no se pueden deshacer solos).
 */
export class CommittingWorkspaces implements WorkspaceManager {
  readonly #inner: WorkspaceManager;
  readonly #git: GitRunner;
  readonly #branch: (projectId: string, workspace: Workspace) => string;
  readonly #log: (line: string) => void;
  readonly #secrets: () => readonly string[];
  readonly #tasks = new Map<string, { projectId: string; task: TaskBrief }>();

  constructor(opts: CommittingWorkspacesOptions) {
    this.#inner = opts.inner;
    this.#git = opts.git ?? createGitRunner();
    this.#branch = opts.integrationBranch ?? (() => DEFAULT_INTEGRATION_BRANCH);
    this.#log = opts.log ?? (() => undefined);
    this.#secrets = opts.secrets ?? (() => []);
  }

  /** El workspace es la carpeta del usuario en modo local. */
  isLocal(workspace: Workspace): boolean {
    return isLocalAware(this.#inner) && this.#inner.isLocal(workspace);
  }

  /** Variables para los agentes de una tarea local: el bloqueo de push por entorno (`undefined` con worktrees). */
  agentEnv(workspace: Workspace): Readonly<Record<string, string>> | undefined {
    return isLocalAware(this.#inner) ? this.#inner.agentEnv?.(workspace) : undefined;
  }

  /** Clave para no correr a la vez dos tareas en la misma carpeta local (`undefined` con worktrees). */
  exclusiveKey(projectId: string): string | undefined {
    if (!isLocalAware(this.#inner)) return undefined;
    try {
      return this.#inner.exclusiveKey(projectId);
    } catch {
      return undefined;
    }
  }

  async create(projectId: string, task: TaskBrief): Promise<Workspace> {
    const workspace = await this.#inner.create(projectId, task);
    this.#tasks.set(taskKey(workspace), { projectId, task });
    return workspace;
  }

  /** Comprueba rutas y confirma lo pendiente (en modo local, nada: no se confirma). */
  async prepare(workspace: Workspace): Promise<CommitResult> {
    const entry = this.#tasks.get(taskKey(workspace));
    if (!entry) throw new OwnedPathsError(workspace.taskId, ['(tarea desconocida: no se puede comprobar ownedPaths)']);
    if (this.isLocal(workspace)) return { files: [] };
    const result = await commitTaskWork(this.#git, workspace.path, entry.task, this.#branch(entry.projectId, workspace), workspace.branch, this.#secrets());
    if (result.commit) this.#log(`${workspace.taskId}: commit ${result.commit.slice(0, 10)} a nombre del usuario (${result.files.length} archivos)`);
    return result;
  }

  /**
   * Paso de la flota antes de la revisión (`FleetOptions.diffSummary`): confirma el trabajo y resume el diff de la
   * rama. Si hay archivos fuera de las rutas propias, se lo dice al revisor (y `integrate` hará fallar la tarea). En
   * modo local resume los archivos que informó el agente (`run`).
   */
  async reviewSummary(workspace: Workspace, run?: ExecuteResult): Promise<string> {
    if (this.isLocal(workspace)) return this.#localSummary(workspace, run);
    try {
      await this.prepare(workspace);
    } catch (err) {
      if (err instanceof OwnedPathsError) return `ATENCIÓN: ${err.message}. Rechaza la tarea y pide deshacer esos cambios.`;
      if (err instanceof SecretInWorkError) {
        return `ATENCIÓN: ${err.message}. Rechaza la tarea y pide quitar la clave${err.committed ? ' y rehacer la rama sin ese commit' : ''}.`;
      }
      throw err;
    }
    const entry = this.#tasks.get(taskKey(workspace));
    const base = this.#branch(entry?.projectId ?? '', workspace);
    const stat = await this.#git(workspace.path, ['diff', '--stat', `${base}...HEAD`]);
    const log = await this.#git(workspace.path, ['log', '--oneline', `${base}..HEAD`]);
    return [`Cambios de la rama ${workspace.branch} frente a ${base} (confirmados por la flota):`, stat.stdout.trim() || '(sin cambios)', '', 'Commits:', log.stdout.trim() || '(ninguno)'].join('\n');
  }

  /** Gate antes de revisar (issue 6): lo corre el gestor interno si sabe hacerlo; si no, `undefined`. */
  async verify(workspace: Workspace, task: TaskBrief, signal?: AbortSignal): Promise<{ ok: boolean; summary: string } | undefined> {
    const inner = this.#inner as WorkspaceManager & { verify?: (w: Workspace, t: TaskBrief, s?: AbortSignal) => Promise<{ ok: boolean; summary: string } | undefined> };
    return typeof inner.verify === 'function' ? inner.verify(workspace, task, signal) : undefined;
  }

  async integrate(projectId: string, workspace: Workspace): Promise<IntegrationResult> {
    if (!this.isLocal(workspace)) {
      try {
        await this.prepare(workspace);
      } catch (err) {
        // Un resultado y no una excepción: la tarea vuelve al autor con el motivo, no queda «Error del orquestador».
        if (err instanceof OwnedPathsError && this.#tasks.has(taskKey(workspace))) return { ok: false, conflicts: [], gateSummary: `no ejecutado: ${err.message}` };
        throw err;
      }
      return this.#inner.integrate(projectId, workspace);
    }
    // Se vuelve a mirar la carpeta: así entra también lo que haya escrito el revisor después del resumen.
    const entry = this.#tasks.get(taskKey(workspace));
    const outside = entry ? outsideOwnedPaths((await this.#changedOnDisk(workspace)) ?? [], entry.task.ownedPaths) : [];
    if (outside.length) {
      return { ok: false, conflicts: [], gateSummary: `local: archivos fuera de las rutas propias: ${listFiles(outside)}. Deshaz esos cambios (en la carpeta del usuario no hay copia de respaldo); si no son tuyos, pudo editarlos el usuario mientras trabajaba la tarea: dilo en tu resumen.` };
    }
    return this.#inner.integrate(projectId, workspace);
  }

  async remove(workspace: Workspace): Promise<void> {
    if (!this.isLocal(workspace)) {
      const tracked = await this.#git(workspace.path, ['ls-files', '--', ORQ_SCRATCH], { check: false });
      if (tracked.code === 0 && tracked.stdout.trim() === '') await rm(join(workspace.path, ORQ_SCRATCH), { recursive: true, force: true });
    }
    await this.#inner.remove(workspace);
    this.#tasks.delete(taskKey(workspace));
  }

  #changedOnDisk(workspace: Workspace): Promise<string[] | undefined> {
    const inner = this.#inner;
    return isLocalAware(inner) && inner.changedSince ? inner.changedSince(workspace) : Promise.resolve(undefined);
  }

  async #localSummary(workspace: Workspace, run?: ExecuteResult): Promise<string> {
    const entry = this.#tasks.get(taskKey(workspace));
    const reported = [...new Set((run?.attempts ?? []).flatMap((a) => a.filesChanged))];
    const outsideFolder: string[] = [];
    const files: string[] = [];
    for (const f of reported) {
      if (!isAbsolute(f)) files.push(normalizeOwnedPath(f));
      else if (isInside(f, workspace.path)) files.push(normalizeOwnedPath(relative(workspace.path, f)));
      else outsideFolder.push(f);
    }
    const visible = [...new Set(files)].filter((f) => f && f !== ORQ_SCRATCH && !f.startsWith(`${ORQ_SCRATCH}/`));
    const changed = await this.#changedOnDisk(workspace);
    const seen = new Set(visible);
    const unreported = (changed ?? []).filter((f) => !seen.has(f));
    const outside = entry ? outsideOwnedPaths([...visible, ...unreported], entry.task.ownedPaths) : [];
    const lines = [
      `Modo local: la tarea trabajó directamente en la carpeta del usuario (${workspace.path}), sin rama ni commits.`,
      visible.length
        ? `Archivos cambiados según los eventos del agente (${String(visible.length)}): ${listFiles(visible, LOCAL_SUMMARY_FILES)}`
        : 'El agente no informó archivos cambiados: revisa la carpeta.',
    ];
    if (unreported.length) {
      lines.push(`Cambiaron en la carpeta y el agente no los informó (por la terminal, o el usuario mientras trabajaba la tarea) (${String(unreported.length)}): ${listFiles(unreported, LOCAL_SUMMARY_FILES)}`);
    } else if (!changed) {
      lines.push('No se pudo comparar la carpeta con su estado al empezar (demasiado grande o ilegible): solo cuenta lo que informó el agente.');
    }
    if (outside.length || outsideFolder.length) {
      lines.push(
        `ATENCIÓN: archivos fuera de las rutas propias (${listFiles([...outside, ...outsideFolder])}). En modo local no se pueden deshacer solos: rechaza la tarea y pide deshacer esos cambios (mientras sigan, la flota no la integra).`,
      );
    }
    const last = run?.attempts.at(-1);
    if (last?.summary) lines.push(`Resumen del autor: ${last.summary}`);
    else if (last?.texts.length) lines.push(`Último mensaje del autor: ${last.texts.at(-1) ?? ''}`);
    return redactSecrets(lines.join('\n'));
  }
}

/** Lista corta de archivos para un mensaje (`…` si hay más de `max`). */
function listFiles(files: readonly string[], max = 20): string {
  return `${files.slice(0, max).join(', ')}${files.length > max ? ' …' : ''}`;
}

function taskKey(workspace: Workspace): string {
  return `${workspace.path}\u0000${workspace.taskId}`;
}
