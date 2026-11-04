import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { IntegrationResult, Workspace, WorkspaceManager } from '../../shared/contracts.ts';
import { taskBriefSchema } from '../../shared/index.ts';
import type { TaskBrief } from '../../shared/index.ts';
import { runCommands, summarizeCommands } from './commands.ts';
import { gitCommonDir, HOOKS_DIR, INTEGRATION_DIR, parseWorkspaceProject, TASK_BRANCH_PREFIX, worktreesRootProblem } from './config.ts';
import type { WorkspaceProject } from './config.ts';
import { createGitRunner, GitError } from './git.ts';
import type { GitRunner } from './git.ts';
import { isInside } from './guard.ts';
import { branchExists, ensureIntegrationBranch, integrateWorkspace } from './integrate.ts';
import { createLinks, excludeLinks, removeAllLinks } from './links.ts';
import { blockPush } from './push-block.ts';

export interface WorktreeManagerOptions {
  /** Configuración por proyecto (dato externo: se valida con Zod). */
  projects: readonly unknown[];
  gitPath?: string;
  /** Reintentos de `remove` ante carpeta retenida (EPERM/EBUSY): en Windows el CLI la suelta ~5 s después. */
  removeRetries?: number;
  removeRetryDelayMs?: number;
  /** Inyectable en pruebas. */
  sleep?: (ms: number) => Promise<void>;
}

export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
}

const BUSY = /EPERM|EBUSY|EACCES|Permission denied|Device or resource busy|being used by another process|Directory not empty/i;

/**
 * Colas por **repositorio git** (su carpeta común, `git-common-dir`) y comunes a todos los gestores del proceso:
 * `repo:<común>` (escrituras en el repo) e `integrate:<común>` (toda la integración: merge, gate y commit). Así dos
 * gestores del mismo repositorio (la configuración anterior y la nueva de un proyecto, o dos proyectos cuyas copias
 * son worktrees del mismo repo) nunca intercalan un merge, un gate ni escrituras de refs o config.
 */
const queues = new Map<string, Promise<unknown>>();

function repoKey(repoPath: string): string {
  const common = gitCommonDir(repoPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? common.toLowerCase() : common;
}

/** Implementa `WorkspaceManager` con un worktree de git por tarea y un worktree de integración propio. */
export class WorktreeManager implements WorkspaceManager {
  private readonly projects = new Map<string, WorkspaceProject>();
  private readonly git: GitRunner;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: WorktreeManagerOptions) {
    for (const raw of opts.projects) {
      const p = parseWorkspaceProject(raw);
      const why = worktreesRootProblem(p);
      if (why) throw new WorkspaceError(why);
      this.projects.set(p.id, p);
    }
    const all = [...this.projects.values()];
    this.git = createGitRunner({ gitPath: opts.gitPath, protectedPaths: all.map((p) => p.repoPath), managedRoots: all.map((p) => p.worktreesRoot) });
    this.retries = opts.removeRetries ?? 8;
    this.retryDelayMs = opts.removeRetryDelayMs ?? 1_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  project(projectId: string): WorkspaceProject {
    const p = this.projects.get(projectId);
    if (!p) throw new WorkspaceError(`proyecto sin configuración de worktrees: ${projectId}`);
    return p;
  }

  /** Busca el proyecto dueño de un worktree por su ruta. */
  private projectOf(workspace: Workspace): WorkspaceProject {
    for (const p of this.projects.values()) if (isInside(workspace.path, p.worktreesRoot)) return p;
    throw new WorkspaceError(`el worktree ${workspace.path} no pertenece a ningún proyecto configurado`);
  }

  async create(projectId: string, task: TaskBrief): Promise<Workspace> {
    const project = this.project(projectId);
    const brief = taskBriefSchema.parse(task);
    const workspace = await this.exclusive(project, () => this.addWorktree(project, brief));
    try {
      // postCreate (p. ej. `npm ci`) no escribe en el repo: corre fuera de la sección exclusiva.
      const results = await runCommands(project.postCreate, workspace.path, undefined, { untrustedRoots: [project.worktreesRoot] });
      if (results.some((r) => !r.ok)) {
        throw new WorkspaceError(`postCreate falló:\n${summarizeCommands(results, project.postCreate.length)}`);
      }
    } catch (err) {
      await this.exclusive(project, () => this.discardFresh(project, workspace)).catch(() => undefined);
      throw err;
    }
    return workspace;
  }

  /** `worktree add` (reutiliza `orq/<tarea>` si ya existe: las ramas nunca se borran), bloqueo de push y enlaces. */
  private async addWorktree(project: WorkspaceProject, brief: TaskBrief): Promise<Workspace> {
    const path = join(project.worktreesRoot, brief.id);
    const branch = `${TASK_BRANCH_PREFIX}${brief.id}`;
    if (existsSync(path)) throw new WorkspaceError(`ya existe el worktree de la tarea: ${path}`);
    await ensureIntegrationBranch(this.git, project);
    await mkdir(project.worktreesRoot, { recursive: true });
    const reuse = await branchExists(this.git, project.repoPath, branch);
    const args = reuse
      ? ['worktree', 'add', '--relative-paths', path, branch]
      : ['worktree', 'add', '--relative-paths', path, '-b', branch, project.integrationBranch];
    await this.git(project.repoPath, args);
    const workspace: Workspace = { taskId: brief.id, path, branch };
    try {
      await blockPush(this.git, path, project.hooksDir);
      await createLinks(project.repoPath, path, project.links);
      await excludeLinks(this.git, path, project.links);
    } catch (err) {
      await this.discardFresh(project, workspace).catch(() => undefined);
      throw err;
    }
    return workspace;
  }

  /**
   * Deshace una creación que falló antes de que el agente trabaje: quita los enlaces, borra la carpeta y poda
   * el registro. No usa `remove` (se negaría por los archivos que dejó `postCreate`) ni `--force`; la rama queda.
   */
  private async discardFresh(project: WorkspaceProject, workspace: Workspace): Promise<void> {
    await removeAllLinks(workspace.path);
    await rm(workspace.path, { recursive: true, force: true, maxRetries: this.retries, retryDelay: this.retryDelayMs });
    await this.git(project.repoPath, ['worktree', 'prune']);
  }

  async integrate(projectId: string, workspace: Workspace): Promise<IntegrationResult> {
    const project = this.project(projectId);
    const exclusive = <T>(fn: () => Promise<T>) => this.exclusive(project, fn);
    return this.serial(`integrate:${repoKey(project.repoPath)}`, () => integrateWorkspace(this.git, project, workspace, { exclusive }));
  }

  /** Sección exclusiva por repositorio físico para todo lo que escribe en el repo (worktree add/remove, ramas, merge, commit). */
  private exclusive<T>(project: WorkspaceProject, fn: () => Promise<T>): Promise<T> {
    return this.serial(`repo:${repoKey(project.repoPath)}`, fn);
  }

  /** Encadena tareas por clave: git no tolera escrituras simultáneas de config/refs del mismo repo. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    queues.set(key, next);
    // Sin fugas: la clave se suelta cuando su último trabajo termina.
    void next.catch(() => undefined).then(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  }

  private async isRegistered(project: WorkspaceProject, path: string): Promise<boolean> {
    const list = (await this.git(project.repoPath, ['worktree', 'list', '--porcelain'])).stdout;
    return list.split(/\r?\n/).some((l) => l.startsWith('worktree ') && samePath(l.slice('worktree '.length), path));
  }

  /** `git worktree remove` sin `--force` y sin borrar la rama. Quita antes los enlaces (ver `removeAllLinks`). */
  async remove(workspace: Workspace): Promise<void> {
    const project = this.projectOf(workspace);
    if (!existsSync(workspace.path)) {
      await this.git(project.repoPath, ['worktree', 'prune']);
      return;
    }
    if (await this.isRegistered(project, workspace.path)) {
      // Antes de tocar los enlaces: con cambios sin confirmar no se quita (no se pierde trabajo).
      const status = (await this.git(workspace.path, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim();
      if (status !== '') {
        throw new WorkspaceError(`el worktree ${workspace.path} tiene cambios sin confirmar; confírmalos antes de quitarlo:\n${status}`);
      }
    } else if (!isLeftover(project, workspace)) {
      // Nunca se borra con rm una carpeta que no sea el resto de un worktree de tarea.
      throw new WorkspaceError(`${workspace.path} no es un worktree registrado del proyecto ${project.id}`);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.exclusive(project, async () => {
          await removeAllLinks(workspace.path);
          if (await this.isRegistered(project, workspace.path)) {
            await this.git(project.repoPath, ['worktree', 'remove', workspace.path]);
          } else {
            // Un intento anterior ya lo desregistró pero Windows retuvo la carpeta: se borra lo que quedó
            // (ya sin enlaces, así que no se toca la copia principal).
            await rm(workspace.path, { recursive: true, force: true });
            await this.git(project.repoPath, ['worktree', 'prune']);
          }
        });
        return;
      } catch (err) {
        if (attempt >= this.retries || !isBusy(err)) throw err;
        await this.sleep(this.retryDelayMs);
      }
    }
  }
}

/** Carpeta de una tarea que git ya desregistró (remove anterior interrumpido): `<worktreesRoot>\\<tarea>` sin `.git`. */
function isLeftover(project: WorkspaceProject, workspace: Workspace): boolean {
  const name = basename(workspace.path);
  return (
    samePath(workspace.path, join(project.worktreesRoot, workspace.taskId)) &&
    name !== INTEGRATION_DIR &&
    name !== HOOKS_DIR &&
    !existsSync(join(workspace.path, '.git'))
  );
}

function samePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a);
}

function isBusy(err: unknown): boolean {
  if (err instanceof GitError) return BUSY.test(err.result.stderr);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}
