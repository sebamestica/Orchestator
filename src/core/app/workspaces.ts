import type { IntegrationResult, TaskBrief, Workspace, WorkspaceManager } from '../../shared/index.ts';
import type { ProjectRecord } from '../store/index.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_REQUIRED, INTEGRATION_DIR, isInside, physicalPath, projectsOverlapProblem, WorkspaceError, WorktreeManager, type WorkspaceProject } from '../workspace/index.ts';

export interface ProjectWorktreesOptions {
  /** Configuración de c3 explícita por proyecto (con `gate`, `links`, `worktreesRoot`…); gana sobre el almacén. */
  projects?: readonly unknown[];
  /** Proyectos del almacén (`POST /projects`): `{ id, repoPath, workspace? }`; `workspace` es la misma configuración de c3. */
  storeProject?: (projectId: string) => ProjectRecord | undefined;
  gitPath?: string;
  log?: (line: string) => void;
}

/** Configuración de c3 de un proyecto del almacén: `workspace` guardado más su `id` y su `repoPath`. */
export function storeWorkspaceConfig(record: ProjectRecord): Record<string, unknown> {
  return { ...record.workspace, id: record.id, repoPath: record.repoPath };
}

/** Error de la flota ante un proyecto sin gate: no se crea ni se integra nada sin verificación. */
export function gateMissing(projectId: string): WorkspaceError {
  return new WorkspaceError(
    `proyecto ${projectId}: sin gate configurado (${GATE_REQUIRED}). Regístralo con «workspace.gate» en POST /projects, o pasa «gate» en compose({ workspaceProjects }).`,
  );
}

/** Un gestor de c3 con la configuración (serializada) con la que se armó. */
interface Entry {
  key: string;
  manager: WorktreeManager;
}

/**
 * `WorkspaceManager` con un `WorktreeManager` de c3 por proyecto, creado al primer uso. Así sirven también los
 * proyectos agregados después de arrancar. Los del almacén se releen en cada uso, y una tarea nueva usa la
 * configuración guardada en ese momento. Cada worktree queda ligado al gestor (y a la configuración) con que se creó
 * hasta quitarlo: se integra y se limpia con esa configuración aunque el proyecto se haya vuelto a registrar. Las
 * integraciones del mismo repositorio físico nunca se intercalan, sea cual sea el gestor (`WorktreeManager`). Sin
 * `gate` no se crea ni se integra ninguna tarea. El servidor rechaza borrar (y por tanto reconfigurar) un proyecto con
 * tareas activas.
 */
export class ProjectWorktrees implements WorkspaceManager {
  readonly #opts: ProjectWorktreesOptions;
  readonly #explicit = new Map<string, unknown>();
  readonly #current = new Map<string, Entry>();
  readonly #bound = new Map<string, { projectId: string; entry: Entry }>();
  /** Configuraciones retiradas cuya raíz aún tiene `_integracion` (no se quita al limpiar las tareas). */
  readonly #retired = new Map<Entry, string>();

  constructor(opts: ProjectWorktreesOptions) {
    this.#opts = opts;
    for (const raw of opts.projects ?? []) {
      const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String((raw as { id: unknown }).id) : '';
      this.#explicit.set(id, raw);
      // Valida al construir: un error de configuración se ve al arrancar, no en la primera tarea.
      this.#entry(id);
    }
  }

  /** Configuración vigente del proyecto (la de las tareas nuevas). */
  project(projectId: string): WorkspaceProject {
    return this.#entry(projectId).manager.project(projectId);
  }

  /** Configuración con la que se creó un worktree (o la vigente, si no lo creó este gestor). */
  projectOf(projectId: string, workspace: Workspace): WorkspaceProject {
    return (this.#bound.get(bindKey(workspace.path))?.entry ?? this.#entry(projectId)).manager.project(projectId);
  }

  async create(projectId: string, task: TaskBrief): Promise<Workspace> {
    const entry = this.#entry(projectId);
    // Antes de crear nada: una tarea sin gate se pararía al integrar, después de gastar el cupo del agente.
    if (entry.manager.project(projectId).gate.length === 0) throw gateMissing(projectId);
    const workspace = await entry.manager.create(projectId, task);
    this.#bound.set(bindKey(workspace.path), { projectId, entry });
    return workspace;
  }

  async integrate(projectId: string, workspace: Workspace): Promise<IntegrationResult> {
    const bound = this.#bound.get(bindKey(workspace.path));
    if (bound && bound.projectId !== projectId) {
      throw new WorkspaceError(`el worktree ${workspace.path} es del proyecto ${bound.projectId}, no de ${projectId}`);
    }
    const entry = bound?.entry ?? this.#entry(projectId);
    const project = entry.manager.project(projectId);
    if (project.gate.length === 0) throw gateMissing(projectId);
    if (!isInside(workspace.path, project.worktreesRoot)) {
      throw new WorkspaceError(`el worktree ${workspace.path} no está en la raíz de worktrees del proyecto ${projectId} (${project.worktreesRoot})`);
    }
    return entry.manager.integrate(projectId, workspace);
  }

  async remove(workspace: Workspace): Promise<void> {
    const key = bindKey(workspace.path);
    const bound = this.#bound.get(key);
    if (bound) {
      await bound.entry.manager.remove(workspace);
      this.#bound.delete(key);
      return;
    }
    // Worktrees de antes de arrancar (no ligados): por la raíz de la configuración vigente.
    for (const [id, entry] of this.#current) {
      if (isInside(workspace.path, entry.manager.project(id).worktreesRoot)) return entry.manager.remove(workspace);
    }
    throw new WorkspaceError(`el worktree ${workspace.path} no pertenece a ningún proyecto configurado`);
  }

  /**
   * La raíz y la copia de una configuración nueva no se solapan con las de otro proyecto vigente ni con las de una
   * configuración retirada que aún tiene worktrees: de tarea (ligados) o el de integración (`_integracion`, que la
   * flota no quita al limpiar las tareas). Si no, la guardia de una dejaría a la flota quitar o pisar worktrees de la
   * otra. Se comparan rutas escritas y físicas, también entre configuraciones del mismo proyecto, que puede volver a
   * usar exactamente su raíz anterior.
   */
  #assertNoOverlap(projectId: string, next: WorkspaceProject, replaced?: Entry): void {
    const others = new Map<Entry, string>();
    for (const [id, entry] of this.#current) if (id !== projectId) others.set(entry, id);
    // La configuración que se reemplaza cuenta ya si conserva su `_integracion` (transición directa R1 → R1\nueva).
    if (replaced && existsSync(join(replaced.manager.project(projectId).worktreesRoot, INTEGRATION_DIR))) others.set(replaced, projectId);
    for (const { projectId: id, entry } of this.#bound.values()) others.set(entry, id);
    for (const [entry, id] of this.#retired) {
      // Una raíz retirada deja de contar cuando ya no queda su `_integracion` en disco (alguien la quitó a mano).
      if (existsSync(join(entry.manager.project(id).worktreesRoot, INTEGRATION_DIR))) others.set(entry, id);
      else this.#retired.delete(entry);
    }
    const mine = { id: projectId, repoPath: next.repoPath, worktreesRoot: next.worktreesRoot };
    for (const [entry, id] of others) {
      const o = entry.manager.project(id);
      if (id !== projectId) {
        const why = projectsOverlapProblem(mine, [{ id, repoPath: o.repoPath, worktreesRoot: o.worktreesRoot }]);
        if (why) throw new WorkspaceError(why);
      } else if (rootsOverlapButDiffer(o.worktreesRoot, next.worktreesRoot)) {
        throw new WorkspaceError(`proyecto ${projectId}: la raíz nueva (${next.worktreesRoot}) se solapa con la anterior (${o.worktreesRoot}), que aún tiene worktrees`);
      }
    }
  }

  #entry(projectId: string): Entry {
    let raw = this.#explicit.get(projectId);
    // La configuración explícita no cambia; la del almacén se compara con la del gestor guardado.
    let key = '';
    if (raw === undefined) {
      const record = this.#opts.storeProject?.(projectId);
      if (!record) throw new WorkspaceError(`proyecto sin configuración de worktrees: ${projectId} (créalo con POST /projects)`);
      raw = storeWorkspaceConfig(record);
      key = JSON.stringify(raw);
    }
    const cached = this.#current.get(projectId);
    if (cached && cached.key === key) return cached;
    const manager = new WorktreeManager({ projects: [raw], ...(this.#opts.gitPath ? { gitPath: this.#opts.gitPath } : {}) });
    this.#assertNoOverlap(projectId, manager.project(projectId), cached);
    if (manager.project(projectId).gate.length === 0) {
      this.#opts.log?.(`proyecto ${projectId}: sin gate configurado; la flota no creará ni integrará sus tareas hasta configurarlo`);
    }
    const entry: Entry = { key, manager };
    // La configuración que se retira sigue protegiendo su raíz mientras le quede un worktree de integración.
    if (cached && existsSync(join(cached.manager.project(projectId).worktreesRoot, INTEGRATION_DIR))) this.#retired.set(cached, projectId);
    this.#current.set(projectId, entry);
    return entry;
  }
}

function bindKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function sameDir(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a);
}

/** Dos raíces se solapan (una cuelga de la otra, por ruta escrita o física) sin ser la misma carpeta. */
function rootsOverlapButDiffer(a: string, b: string): boolean {
  const pa = physicalPath(a);
  const pb = physicalPath(b);
  if (sameDir(a, b) || sameDir(pa, pb)) return false;
  return [a, pa].some((x) => [b, pb].some((y) => isInside(x, y) || isInside(y, x)));
}
