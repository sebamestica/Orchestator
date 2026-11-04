import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationResult, TaskBrief, Workspace, WorkspaceManager } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
import { normalizeOwnedPath, pathsOverlap } from '../orchestrator/index.ts';
import { createGitRunner, DEFAULT_INTEGRATION_BRANCH, type GitRunner } from '../workspace/index.ts';

/** Carpeta de trabajo del orquestador en cada worktree (BRIEF, HANDOFF, último mensaje): nunca se confirma. */
export const ORQ_SCRATCH = '.orq';

/** Identidad de los commits que hace la flota por el agente. */
export const FLEET_IDENTITY = { name: 'Orquestador (flota)', email: 'orquestador@localhost' };

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

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: FLEET_IDENTITY.name,
  GIT_AUTHOR_EMAIL: FLEET_IDENTITY.email,
  GIT_COMMITTER_NAME: FLEET_IDENTITY.name,
  GIT_COMMITTER_EMAIL: FLEET_IDENTITY.email,
};

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
  const message = redactSecrets(`${task.id}: ${task.title}\n\nCommit de la flota del orquestador con el trabajo del agente.`);
  await git(worktreePath, ['commit', '-q', '-m', message], { env: COMMIT_ENV });
  const commit = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
  return { files: [...new Set(pending.map(normalizeOwnedPath))], commit };
}

export interface CommittingWorkspacesOptions {
  inner: WorkspaceManager;
  /** Rama desde la que se creó la rama de la tarea (por defecto `orq/integracion`): la de la configuración del worktree. */
  integrationBranch?: (projectId: string, workspace: Workspace) => string;
  git?: GitRunner;
  log?: (line: string) => void;
}

/**
 * Decorador de `WorkspaceManager`: antes de integrar comprueba las rutas propias y confirma el trabajo del agente
 * (ver `commitTaskWork`); si algo queda fuera, `integrate` lanza `OwnedPathsError` y la flota da la tarea por fallida
 * con ese mensaje. `prepare` hace lo mismo antes de la revisión (`diffSummaryStep`). Al quitar un worktree borra
 * primero su `.orq` si no está versionada, para que `remove` no lo tome por trabajo sin confirmar.
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

  async create(projectId: string, task: TaskBrief): Promise<Workspace> {
    const workspace = await this.#inner.create(projectId, task);
    this.#tasks.set(workspace.path, { projectId, task });
    return workspace;
  }

  /** Comprueba rutas y confirma lo pendiente. */
  async prepare(workspace: Workspace): Promise<CommitResult> {
    const entry = this.#tasks.get(workspace.path);
    if (!entry) throw new OwnedPathsError(workspace.taskId, ['(tarea desconocida: no se puede comprobar ownedPaths)']);
    const result = await commitTaskWork(this.#git, workspace.path, entry.task, this.#branch(entry.projectId, workspace));
    if (result.commit) this.#log(`${workspace.taskId}: commit ${result.commit.slice(0, 10)} de la flota (${result.files.length} archivos)`);
    return result;
  }

  /**
   * Paso de la flota antes de la revisión (`FleetOptions.diffSummary`): confirma el trabajo y resume el diff de la
   * rama. Si hay archivos fuera de las rutas propias, se lo dice al revisor (y `integrate` hará fallar la tarea).
   */
  async reviewSummary(workspace: Workspace): Promise<string> {
    try {
      await this.prepare(workspace);
    } catch (err) {
      if (err instanceof OwnedPathsError) return `ATENCIÓN: ${err.message}. Rechaza la tarea y pide deshacer esos cambios.`;
      throw err;
    }
    const entry = this.#tasks.get(workspace.path);
    const base = this.#branch(entry?.projectId ?? '', workspace);
    const stat = await this.#git(workspace.path, ['diff', '--stat', `${base}...HEAD`]);
    const log = await this.#git(workspace.path, ['log', '--oneline', `${base}..HEAD`]);
    return [`Cambios de la rama ${workspace.branch} frente a ${base} (confirmados por la flota):`, stat.stdout.trim() || '(sin cambios)', '', 'Commits:', log.stdout.trim() || '(ninguno)'].join('\n');
  }

  async integrate(projectId: string, workspace: Workspace): Promise<IntegrationResult> {
    await this.prepare(workspace);
    return this.#inner.integrate(projectId, workspace);
  }

  async remove(workspace: Workspace): Promise<void> {
    const tracked = await this.#git(workspace.path, ['ls-files', '--', ORQ_SCRATCH], { check: false });
    if (tracked.code === 0 && tracked.stdout.trim() === '') await rm(join(workspace.path, ORQ_SCRATCH), { recursive: true, force: true });
    await this.#inner.remove(workspace);
    this.#tasks.delete(workspace.path);
  }
}
