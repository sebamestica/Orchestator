import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { IntegrationResult, TaskBrief, Workspace } from '../../shared/index.ts';
import { idSchema, PLAN_FILES, redactSecrets } from '../../shared/index.ts';
import { deduceGate, gateForWorkspace } from '../fs/folders.ts';
import { createGitRunner, physicalPath, pushBlockEnv, runCommands, summarizeCommands, WorkspaceError, type CommandSpec, type GitRunner } from '../workspace/index.ts';
import { changedPaths, snapshotFolder, type FolderSnapshot } from './folder-snapshot.ts';

/**
 * Rama ficticia de un workspace local: no hay rama, se trabaja sobre la carpeta del usuario. No es un nombre de rama
 * válido de git a propósito, para que ningún paso la confunda con una real.
 */
export const LOCAL_BRANCH = '(local)';
/** Carpeta de trabajo del orquestador dentro de la carpeta del proyecto (BRIEF, PLAN, HANDOFF…). */
const SCRATCH = '.orq';
/** Marca de que `.orq/` la creó el modo local (y por tanto se puede borrar al terminar). */
export const LOCAL_MARKER = join(SCRATCH, '.berland-local');
/** Estado apartado de las tareas que no terminaron bien: `.orq/tareas/<id>/` (su plan y su HANDOFF). */
const PARKED = join(SCRATCH, 'tareas');
/** Archivos de `.orq/` que son de cada tarea (la flota reescribe BRIEF y PLAN antes de cada intento). */
const TASK_STATE = [basename(PLAN_FILES.taskPlan), basename(PLAN_FILES.handoff)];
const MARKER_TEXT = 'Carpeta de trabajo de Berland en modo local: se borra al terminar bien cada tarea.';
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
 *   en `info/exclude`. Calcula también el bloqueo de push por entorno (`agentEnv`): no hay `config.worktree` donde
 *   escribirlo y la config del usuario no se toca.
 * - `integrate` corre el gate si la carpeta tiene uno (si falla, la tarea vuelve al autor); si no, da por buena la
 *   tarea revisada. Nunca confirma nada. Si `verify` ya lo pasó antes de revisar y la carpeta no cambió desde
 *   entonces (misma foto), no lo repite.
 * - `remove` borra solo `.orq/`, y solo si la creó el modo local.
 *
 * `.orq/` es una por carpeta, pero el plan (`PLAN-TAREA.md`) y el `HANDOFF.md` son de cada tarea: la marca guarda qué
 * tarea es dueña del estado. Al empezar otra, el de la anterior (una fallida) se aparta en `.orq/tareas/<id>/` y vuelve
 * a su sitio cuando esa tarea se reintenta; `remove` no borra lo apartado.
 *
 * Dos tareas de la misma carpeta no deben correr a la vez (se pisarían `.orq/BRIEF.md` y los archivos): la flota lo
 * evita con `exclusiveKey`.
 */
export class LocalWorkspaces {
  readonly #gateFor: (dir: string) => Promise<CommandSpec[] | null>;
  readonly #git: GitRunner | undefined;
  readonly #log: (line: string) => void;
  /** Workspaces locales vivos, por ruta normalizada + tarea, con el entorno de sus agentes. */
  readonly #live = new Map<string, { project: LocalProject; env: Readonly<Record<string, string>> }>();
  /** Último `verify` bueno de cada workspace vivo, con la foto de la carpeta justo después del gate. */
  readonly #verified = new Map<string, { summary: string; snapshot: FolderSnapshot }>();

  constructor(opts: LocalWorkspacesOptions = {}) {
    this.#gateFor = opts.gateFor ?? defaultGateFor;
    this.#git = opts.git;
    this.#log = opts.log ?? (() => undefined);
  }

  /**
   * Clave de exclusión de una carpeta local: la carpeta física (junctions y enlaces resueltos), así la misma carpeta
   * escrita distinto o alcanzada por otra ruta da la misma clave (en Windows, además, sin mayúsculas).
   */
  static key(repoPath: string, platform: NodeJS.Platform = process.platform): string {
    const r = physicalPath(resolve(repoPath)).replace(/[\\/]+$/, '');
    return platform === 'win32' ? r.toLowerCase() : r;
  }

  isLocal(workspace: Workspace): boolean {
    return this.projectOf(workspace) !== undefined;
  }

  /** Proyecto de un workspace local vivo (creado por este gestor y aún no quitado). */
  projectOf(workspace: Workspace): LocalProject | undefined {
    return workspace.branch === LOCAL_BRANCH ? this.#live.get(liveKey(workspace))?.project : undefined;
  }

  /** Variables para los agentes de un workspace local vivo: el bloqueo de push (`pushBlockEnv`). */
  agentEnv(workspace: Workspace): Readonly<Record<string, string>> | undefined {
    return workspace.branch === LOCAL_BRANCH ? this.#live.get(liveKey(workspace))?.env : undefined;
  }

  async create(project: LocalProject, task: TaskBrief): Promise<Workspace> {
    if (!isAbsolute(project.repoPath)) throw new WorkspaceError(`proyecto ${project.id}: la carpeta debe ser una ruta absoluta (${project.repoPath})`);
    if (!(await isDir(project.repoPath))) throw new WorkspaceError(`proyecto ${project.id}: la carpeta ${project.repoPath} no existe`);
    const env = await pushBlockEnv(this.#gitFor(project), project.repoPath);
    const scratch = join(project.repoPath, SCRATCH);
    const ours = !(await exists(scratch)) || (await exists(join(project.repoPath, LOCAL_MARKER)));
    await mkdir(scratch, { recursive: true });
    if (ours) {
      try {
        await this.#takeState(project.repoPath, task.id);
      } catch (err) {
        this.#log(redactSecrets(`${task.id}: no se pudo apartar el estado de otra tarea en .orq/ (${err instanceof Error ? err.message : String(err)})`));
      }
    }
    await this.#excludeScratch(project);
    const workspace: Workspace = { taskId: task.id, path: project.repoPath, branch: LOCAL_BRANCH };
    // Solo corre una tarea a la vez por carpeta: lo que quede de esta carpeta es de una tarea fallida (la flota
    // conserva su `.orq/` y no llama a `remove`). Se olvida para que no impida limpiar al terminar esta.
    const folder = LocalWorkspaces.key(project.repoPath);
    for (const [key, live] of this.#live) {
      if (LocalWorkspaces.key(live.project.repoPath) !== folder) continue;
      this.#live.delete(key);
      this.#verified.delete(key);
    }
    this.#verified.delete(liveKey(workspace));
    this.#live.set(liveKey(workspace), { project, env });
    this.#log(`${task.id}: modo local en ${project.repoPath} (sin worktree ni commits)`);
    return workspace;
  }

  async integrate(project: LocalProject, workspace: Workspace, signal?: AbortSignal): Promise<IntegrationResult> {
    const verified = await this.#takeVerified(project, workspace);
    if (verified !== undefined) return { ok: true, conflicts: [], gateSummary: `${verified} (ya verificado antes de revisar)` };
    const check = await this.#runGate(project, workspace, signal);
    if (!check) return { ok: true, conflicts: [], gateSummary: LOCAL_NO_GATE_SUMMARY };
    return { ok: check.ok, conflicts: [], gateSummary: check.summary };
  }

  /** Gate de la carpeta antes de revisar (sin LLM). `undefined` si la carpeta no tiene verificación. */
  async verify(project: LocalProject, workspace: Workspace, signal?: AbortSignal): Promise<{ ok: boolean; summary: string } | undefined> {
    const key = liveKey(workspace);
    this.#verified.delete(key);
    const check = await this.#runGate(project, workspace, signal);
    if (check?.ok) {
      const snapshot = await snapshotFolder(project.repoPath);
      if (snapshot) this.#verified.set(key, { summary: check.summary, snapshot });
    }
    return check;
  }

  /** Resumen del `verify` bueno del workspace si la carpeta sigue igual (se consume: sirve una sola vez). */
  async #takeVerified(project: LocalProject, workspace: Workspace): Promise<string | undefined> {
    const key = liveKey(workspace);
    const entry = this.#verified.get(key);
    this.#verified.delete(key);
    if (!entry) return undefined;
    const now = await snapshotFolder(project.repoPath);
    return now && changedPaths(entry.snapshot, now).length === 0 ? entry.summary : undefined;
  }

  async #runGate(project: LocalProject, workspace: Workspace, signal?: AbortSignal): Promise<{ ok: boolean; summary: string } | undefined> {
    let gate: CommandSpec[] | null;
    try {
      gate = await this.#gateFor(project.repoPath);
    } catch (err) {
      return { ok: false, summary: `local: no se pudo leer la verificación de la carpeta (${redactSecrets(err instanceof Error ? err.message : String(err))})` };
    }
    if (!gate || gate.length === 0) return undefined;
    // El programa del gate no se busca dentro de la carpeta: el agente pudo dejar ahí un `npm.cmd` propio.
    const results = await runCommands(gate, workspace.path, signal, { untrustedRoots: [project.repoPath] });
    const ok = results.length === gate.length && results.every((r) => r.ok);
    return { ok, summary: `local: ${summarizeCommands(results, gate.length)}` };
  }

  async remove(workspace: Workspace): Promise<void> {
    const key = liveKey(workspace);
    const project = this.#live.get(key)?.project;
    if (!project) return;
    this.#live.delete(key);
    this.#verified.delete(key);
    // Otra tarea viva de la misma carpeta aún usa `.orq/` (no debería pasar: la flota las serializa).
    const folder = LocalWorkspaces.key(project.repoPath);
    if ([...this.#live.values()].some((live) => LocalWorkspaces.key(live.project.repoPath) === folder)) return;
    if (!(await exists(join(project.repoPath, LOCAL_MARKER)))) return;
    const scratch = join(project.repoPath, SCRATCH);
    if (!(await hasEntries(join(project.repoPath, PARKED)))) return rm(scratch, { recursive: true, force: true });
    // Queda estado apartado de otras tareas: se borra solo lo de esta (todo lo demás de `.orq/`).
    for (const name of await readdir(scratch)) {
      if (name !== basename(PARKED) && name !== basename(LOCAL_MARKER)) await rm(join(scratch, name), { recursive: true, force: true });
    }
  }

  /**
   * Deja `.orq/` con el estado de `taskId`: aparta el plan y el HANDOFF de la tarea anterior (si era otra) en
   * `.orq/tareas/<anterior>/`, devuelve los de `taskId` si estaban apartados y la anota como dueña en la marca.
   */
  async #takeState(dir: string, taskId: string): Promise<void> {
    const scratch = join(dir, SCRATCH);
    const owner = parseOwner(await readFile(join(dir, LOCAL_MARKER), 'utf8').catch(() => ''));
    if (owner !== taskId) {
      // Sin dueño (marca de antes de esta versión) no se sabe de quién es: se deja donde está.
      const out = owner ? await parkedDir(dir, owner) : undefined;
      if (out) await moveFiles(scratch, out);
      const back = await parkedDir(dir, taskId);
      if (back && (await isDir(back))) {
        await moveFiles(back, scratch);
        await rm(back, { recursive: true, force: true });
        await rmdir(join(dir, PARKED)).catch(() => undefined); // solo si quedó vacía
      }
    }
    await writeFile(join(dir, LOCAL_MARKER), `${MARKER_TEXT}\ntarea: ${taskId}\n`, 'utf8');
  }

  /** git de solo lectura, con la guardia que protege la carpeta del usuario. */
  #gitFor(project: LocalProject): GitRunner {
    return this.#git ?? createGitRunner({ protectedPaths: [project.repoPath] });
  }

  /** `.orq/` fuera de `git status` del usuario: en `info/exclude`, que no se versiona. Sin git, nada. */
  async #excludeScratch(project: LocalProject): Promise<void> {
    if (!(await exists(join(project.repoPath, '.git')))) return;
    try {
      const out = await this.#gitFor(project)(project.repoPath, ['rev-parse', '--git-path', 'info/exclude'], { check: false });
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

/** Tarea dueña del estado de `.orq/` según la marca (solo un id válido: la marca está al alcance del agente). */
function parseOwner(marker: string): string | undefined {
  const id = /^tarea: (.+)$/m.exec(marker)?.[1]?.trim();
  return id && idSchema.safeParse(id).success ? id : undefined;
}

/** `.orq/tareas/<id>` si es una carpeta de verdad o aún no existe; `undefined` si hay un enlace en medio (llevaría fuera). */
async function parkedDir(dir: string, id: string): Promise<string | undefined> {
  for (const p of [join(dir, PARKED), join(dir, PARKED, id)]) {
    const st = await lstat(p).catch(() => undefined);
    if (st && !st.isDirectory()) return undefined;
  }
  return join(dir, PARKED, id);
}

/** Mueve el plan y el HANDOFF de una tarea de `from` a `to` (los que existan). */
async function moveFiles(from: string, to: string): Promise<void> {
  for (const name of TASK_STATE) {
    if (!(await exists(join(from, name)))) continue;
    await mkdir(to, { recursive: true });
    await rm(join(to, name), { force: true });
    await rename(join(from, name), join(to, name));
  }
}

async function hasEntries(dir: string): Promise<boolean> {
  return (await readdir(dir).catch(() => [])).length > 0;
}

function liveKey(workspace: Workspace): string {
  return `${LocalWorkspaces.key(workspace.path)}\u0000${workspace.taskId}`;
}
