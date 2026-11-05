import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { IntegrationResult, TaskBrief, Workspace, WorkspaceManager } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
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

export interface CommitResult {
  /** Archivos confirmados ahora (vacío si no había nada pendiente). */
  files: string[];
  commit?: string;
}

/** Archivos por llamada a `git add` (la línea de órdenes de Windows admite ~32 000 caracteres). */
const ADD_BATCH = 100;

/**
 * Comprueba que todo lo que cambió la tarea (sin confirmar y ya confirmado desde `baseRef`) está dentro de sus
 * `ownedPaths` y confirma lo pendiente en la rama de la tarea. Lanza `OwnedPathsError` si algo queda fuera
 * (entonces no confirma nada). Codex no puede hacer commits en su sandbox y otros agentes lo olvidan.
 */
export async function commitTaskWork(git: GitRunner, worktreePath: string, task: TaskBrief, baseRef: string): Promise<CommitResult> {
  const status = await git(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const pending = parsePorcelainZ(status.stdout).filter((f) => !isScratch(f));
  const committed = (await git(worktreePath, ['diff', '--name-only', '-z', `${baseRef}...HEAD`])).stdout.split('\0').filter(Boolean);
  const outside = outsideOwnedPaths([...pending, ...committed], task.ownedPaths);
  if (outside.length) throw new OwnedPathsError(task.id, outside);
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
}

/** Gestor interno que distingue el modo local (lo implementa `ProjectWorktrees`). */
interface LocalAware {
  isLocal(workspace: Workspace): boolean;
  exclusiveKey(projectId: string): string | undefined;
}

function isLocalAware(inner: WorkspaceManager): inner is WorkspaceManager & LocalAware {
  const m = inner as Partial<LocalAware>;
  return typeof m.isLocal === 'function' && typeof m.exclusiveKey === 'function';
}

/** Máximo de archivos que se listan en el resumen del modo local. */
const LOCAL_SUMMARY_FILES = 200;

/**
 * Decorador de `WorkspaceManager`: antes de integrar comprueba las rutas propias y confirma el trabajo del agente
 * (ver `commitTaskWork`); si algo queda fuera, `integrate` lanza `OwnedPathsError` y la flota da la tarea por fallida
 * con ese mensaje. `prepare` hace lo mismo antes de la revisión (`diffSummaryStep`). Al quitar un worktree borra
 * primero su `.orq` si no está versionada, para que `remove` no lo tome por trabajo sin confirmar.
 *
 * En **modo local** (carpeta del usuario, sin worktree) no hay nada que confirmar: no se ejecuta ningún git que
 * escriba. El resumen para el revisor sale de los archivos que informó el agente, y los que caen fuera de sus rutas
 * propias se le señalan para que rechace la tarea (sin git no se pueden bloquear).
 */
export class CommittingWorkspaces implements WorkspaceManager {
  readonly #inner: WorkspaceManager;
  readonly #git: GitRunner;
  readonly #branch: (projectId: string, workspace: Workspace) => string;
  readonly #log: (line: string) => void;
  readonly #tasks = new Map<string, { projectId: string; task: TaskBrief }>();

  constructor(opts: CommittingWorkspacesOptions) {
    this.#inner = opts.inner;
    this.#git = opts.git ?? createGitRunner();
    this.#branch = opts.integrationBranch ?? (() => DEFAULT_INTEGRATION_BRANCH);
    this.#log = opts.log ?? (() => undefined);
  }

  /** El workspace es la carpeta del usuario en modo local. */
  isLocal(workspace: Workspace): boolean {
    return isLocalAware(this.#inner) && this.#inner.isLocal(workspace);
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
    const result = await commitTaskWork(this.#git, workspace.path, entry.task, this.#branch(entry.projectId, workspace));
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
    if (!this.isLocal(workspace)) await this.prepare(workspace);
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

  #localSummary(workspace: Workspace, run?: ExecuteResult): string {
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
    const outside = entry ? outsideOwnedPaths(visible, entry.task.ownedPaths) : [];
    const lines = [
      `Modo local: la tarea trabajó directamente en la carpeta del usuario (${workspace.path}), sin rama ni commits.`,
      visible.length
        ? `Archivos cambiados según los eventos del agente (${String(visible.length)}): ${visible.slice(0, LOCAL_SUMMARY_FILES).join(', ')}${visible.length > LOCAL_SUMMARY_FILES ? ' …' : ''}`
        : 'El agente no informó archivos cambiados: revisa la carpeta.',
    ];
    if (outside.length || outsideFolder.length) {
      lines.push(
        `ATENCIÓN: archivos fuera de las rutas propias (${[...outside, ...outsideFolder].slice(0, 20).join(', ')}). En modo local no se pueden bloquear: rechaza la tarea y pide deshacer esos cambios.`,
      );
    }
    const last = run?.attempts.at(-1);
    if (last?.summary) lines.push(`Resumen del autor: ${last.summary}`);
    else if (last?.texts.length) lines.push(`Último mensaje del autor: ${last.texts.at(-1) ?? ''}`);
    return redactSecrets(lines.join('\n'));
  }
}

function taskKey(workspace: Workspace): string {
  return `${workspace.path}\u0000${workspace.taskId}`;
}
