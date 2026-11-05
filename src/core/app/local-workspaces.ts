import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { IntegrationResult, TaskBrief, Workspace } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
import { deduceGate, gateForWorkspace } from '../fs/folders.ts';
import { createGitRunner, runCommands, summarizeCommands, WorkspaceError, type CommandSpec, type GitRunner } from '../workspace/index.ts';

/**
 * Rama ficticia de un workspace local: no hay rama, se trabaja sobre la carpeta del usuario. No es un nombre de rama
 * válido de git a propósito, para que ningún paso la confunda con una real.
 */
export const LOCAL_BRANCH = '(local)';
/** Carpeta de trabajo del orquestador dentro de la carpeta del proyecto (BRIEF, PLAN, HANDOFF…). */
const SCRATCH = '.orq';
/** Marca de que `.orq/` la creó el modo local (y por tanto se puede borrar al terminar). */
export const LOCAL_MARKER = join(SCRATCH, '.berland-local');
/** Línea que se agrega a `info/exclude` del repositorio (nunca al `.gitignore` del usuario). */
const EXCLUDE_LINE = '/.orq/';

export const LOCAL_NO_GATE_SUMMARY = 'local: sin verificación (gate) en la carpeta; los cambios quedan en ella, sin commit';

/** Proyecto en modo local: registrado sin `workspace` (sin git o sin gate). */
export interface LocalProject {
  id: string;
  repoPath: string;
}

export interface LocalWorkspacesOptions {
  /** Gate de la carpeta en el momento de integrar; por defecto `deduceGate` (package.json o pytest). */
  gateFor?: (dir: string) => Promise<CommandSpec[] | null>;
  /** git de solo lectura del núcleo (para `info/exclude`); con la guardia, que protege la copia del usuario. */
  git?: GitRunner;
  log?: (line: string) => void;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultGateFor(dir: string): Promise<CommandSpec[] | null> {
  const { gate } = await deduceGate(dir);
  return gate ? gateForWorkspace(gate).map((g) => ({ ...g, env: {} })) : null;
}

/**
 * Modo local: el agente trabaja directamente en la carpeta del proyecto, sin worktree, sin ramas, sin merge y sin
 * commits del núcleo. Lo usan los proyectos registrados sin `workspace` (carpeta sin git o sin gate).
 *
 * - `create` devuelve la carpeta del proyecto y prepara `.orq/` (con su marca); si la carpeta es git, excluye `.orq/`
 *   en `info/exclude`.
 * - `integrate` corre el gate si la carpeta tiene uno (si falla, la tarea vuelve al autor); si no, da por buena la
 *   tarea revisada. Nunca confirma nada.
 * - `remove` borra solo `.orq/`, y solo si la creó el modo local.
 *
 * Dos tareas de la misma carpeta no deben correr a la vez (se pisarían `.orq/BRIEF.md` y los archivos): la flota lo
 * evita con `exclusiveKey`.
 */
export class LocalWorkspaces {
  readonly #gateFor: (dir: string) => Promise<CommandSpec[] | null>;
  readonly #git: GitRunner | undefined;
  readonly #log: (line: string) => void;
  /** Workspaces locales vivos, por ruta normalizada + tarea. */
  readonly #live = new Map<string, LocalProject>();

  constructor(opts: LocalWorkspacesOptions = {}) {
    this.#gateFor = opts.gateFor ?? defaultGateFor;
    this.#git = opts.git;
    this.#log = opts.log ?? (() => undefined);
  }

  /** Clave de exclusión de una carpeta local (misma carpeta escrita distinto → misma clave en Windows). */
  static key(repoPath: string, platform: NodeJS.Platform = process.platform): string {
    const r = resolve(repoPath).replace(/[\\/]+$/, '');
    return platform === 'win32' ? r.toLowerCase() : r;
  }

  isLocal(workspace: Workspace): boolean {
    return this.projectOf(workspace) !== undefined;
  }

  /** Proyecto de un workspace local vivo (creado por este gestor y aún no quitado). */
  projectOf(workspace: Workspace): LocalProject | undefined {
    return workspace.branch === LOCAL_BRANCH ? this.#live.get(liveKey(workspace)) : undefined;
  }

  async create(project: LocalProject, task: TaskBrief): Promise<Workspace> {
    if (!isAbsolute(project.repoPath)) throw new WorkspaceError(`proyecto ${project.id}: la carpeta debe ser una ruta absoluta (${project.repoPath})`);
    if (!(await isDir(project.repoPath))) throw new WorkspaceError(`proyecto ${project.id}: la carpeta ${project.repoPath} no existe`);
    const scratch = join(project.repoPath, SCRATCH);
    const ours = !(await exists(scratch)) || (await exists(join(project.repoPath, LOCAL_MARKER)));
    await mkdir(scratch, { recursive: true });
    if (ours) await writeFile(join(project.repoPath, LOCAL_MARKER), 'Carpeta de trabajo de Berland en modo local: se borra al terminar bien cada tarea.\n', 'utf8');
    await this.#excludeScratch(project);
    const workspace: Workspace = { taskId: task.id, path: project.repoPath, branch: LOCAL_BRANCH };
    // Solo corre una tarea a la vez por carpeta: lo que quede de esta carpeta es de una tarea fallida (la flota
    // conserva su `.orq/` y no llama a `remove`). Se olvida para que no impida limpiar al terminar esta.
    const folder = LocalWorkspaces.key(project.repoPath);
    for (const [key, p] of this.#live) if (LocalWorkspaces.key(p.repoPath) === folder) this.#live.delete(key);
    this.#live.set(liveKey(workspace), project);
    this.#log(`${task.id}: modo local en ${project.repoPath} (sin worktree ni commits)`);
    return workspace;
  }

  async integrate(project: LocalProject, workspace: Workspace, signal?: AbortSignal): Promise<IntegrationResult> {
    let gate: CommandSpec[] | null;
    try {
      gate = await this.#gateFor(project.repoPath);
    } catch (err) {
      return { ok: false, conflicts: [], gateSummary: `local: no se pudo leer la verificación de la carpeta (${redactSecrets(err instanceof Error ? err.message : String(err))})` };
    }
    if (!gate || gate.length === 0) return { ok: true, conflicts: [], gateSummary: LOCAL_NO_GATE_SUMMARY };
    // El programa del gate no se busca dentro de la carpeta: el agente pudo dejar ahí un `npm.cmd` propio.
    const results = await runCommands(gate, workspace.path, signal, { untrustedRoots: [project.repoPath] });
    const summary = summarizeCommands(results, gate.length);
    const ok = results.length === gate.length && results.every((r) => r.ok);
    return { ok, conflicts: [], gateSummary: `local: ${summary}` };
  }

  async remove(workspace: Workspace): Promise<void> {
    const key = liveKey(workspace);
    const project = this.#live.get(key);
    if (!project) return;
    this.#live.delete(key);
    // Otra tarea viva de la misma carpeta aún usa `.orq/` (no debería pasar: la flota las serializa).
    const folder = LocalWorkspaces.key(project.repoPath);
    if ([...this.#live.values()].some((p) => LocalWorkspaces.key(p.repoPath) === folder)) return;
    if (await exists(join(project.repoPath, LOCAL_MARKER))) await rm(join(project.repoPath, SCRATCH), { recursive: true, force: true });
  }

  /** `.orq/` fuera de `git status` del usuario: en `info/exclude`, que no se versiona. Sin git, nada. */
  async #excludeScratch(project: LocalProject): Promise<void> {
    if (!(await exists(join(project.repoPath, '.git')))) return;
    try {
      const git = this.#git ?? createGitRunner({ protectedPaths: [project.repoPath] });
      const out = await git(project.repoPath, ['rev-parse', '--git-path', 'info/exclude'], { check: false });
      const rel = out.code === 0 ? out.stdout.trim() : '';
      if (!rel) return;
      const file = isAbsolute(rel) ? rel : join(project.repoPath, rel);
      const current = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/);
      if (current.some((l) => l.trim() === EXCLUDE_LINE || l.trim() === '.orq/' || l.trim() === '.orq')) return;
      await mkdir(join(file, '..'), { recursive: true });
      const prefix = current.length > 0 && current.at(-1) !== '' ? '\n' : '';
      await appendFile(file, `${prefix}# Berland (modo local)\n${EXCLUDE_LINE}\n`, 'utf8');
    } catch (err) {
      // No impide trabajar: `.orq/` solo aparecería en `git status` del usuario.
      this.#log(redactSecrets(`proyecto ${project.id}: no se pudo excluir .orq/ en git (${err instanceof Error ? err.message : String(err)})`));
    }
  }
}

function liveKey(workspace: Workspace): string {
  return `${LocalWorkspaces.key(workspace.path)}\u0000${workspace.taskId}`;
}
