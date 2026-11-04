import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { idSchema } from '../../shared/index.ts';
import { isInside } from './guard.ts';

/** Rama de integración por defecto (PLAN §4: nunca se integra en la rama del usuario). */
export const DEFAULT_INTEGRATION_BRANCH = 'orq/integracion';
/** Prefijo de las ramas de tarea. */
export const TASK_BRANCH_PREFIX = 'orq/';
/** Nombre de la carpeta del worktree de integración dentro de `worktreesRoot`. */
export const INTEGRATION_DIR = '_integracion';
/** Carpeta de hooks del orquestador (con `pre-push` que rechaza) dentro de `worktreesRoot`. */
export const HOOKS_DIR = '_hooks';

/**
 * Variables que cambian qué programa o qué código se carga (búsqueda de ejecutables, intérprete de cmd, módulos
 * precargados de Node, configuración de npm). Nunca vienen de la configuración de un proyecto: solo del entorno
 * del núcleo.
 */
export const LOADER_ENV = /^(?:path|pathext|comspec|systemroot|windir|nodefaultcurrentdirectoryinexepath|node_options|node_path|npm_config_.+)$/i;

/** Nombre del PATH (`node`, `npm`, `git`…) o ruta absoluta; nunca relativa (se resolvería contra el worktree). */
const commandSchema = z
  .string()
  .min(1)
  .refine((c) => !/[\\/]/.test(c) || /^[A-Za-z]:[\\/]/.test(c) || /^\\\\[^\\]/.test(c) || c.startsWith('/'), 'nombre del PATH o ruta absoluta, nunca relativa');

/**
 * Comando sin shell: ejecutable y argumentos tal cual. `node`, `npm` y `npx` usan el Node del núcleo; otro nombre se
 * busca en el PATH del núcleo, nunca en el worktree (ver `resolveLaunch`). En Windows, `.cmd` vía el cmd.exe del sistema.
 */
export const commandSpecSchema = z.strictObject({
  command: commandSchema,
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(6 * 60 * 60_000).default(10 * 60_000),
  /** Variables extra (sin claves: el gate no las necesita), nunca las que cambian qué se carga (`LOADER_ENV`). */
  env: z
    .record(z.string(), z.string())
    .refine((env) => !Object.keys(env).some((k) => LOADER_ENV.test(k)), 'env no puede cambiar PATH, PATHEXT, ComSpec, NODE_OPTIONS, NODE_PATH ni npm_config_*')
    .default({}),
});
export type CommandSpec = z.infer<typeof commandSpecSchema>;
export type CommandSpecInput = z.input<typeof commandSpecSchema>;

export const branchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*[/.]$)[A-Za-z0-9._/-]+$/, 'nombre de rama no válido');

/** Ruta absoluta con unidad (`C:\\…`; fuera de Windows, `/…`). Nunca relativa: se resolvería contra el cwd del núcleo. */
export function isAbsoluteDir(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : posix.isAbsolute(p);
}
const absoluteDirSchema = z.string().min(1).refine((p) => isAbsoluteDir(p), 'ruta absoluta con unidad (C:\\…)');

/** Ruta relativa a la raíz del repo, sin salir de él. */
const relPathSchema = z
  .string()
  .min(1)
  .refine((p) => !win32.isAbsolute(p) && !p.startsWith('/') && !p.split(/[\\/]/).includes('..'), 'ruta relativa sin «..»');

export const workspaceProjectSchema = z.strictObject({
  id: idSchema,
  /** Copia principal del usuario: solo se usa para `git worktree add/remove`; nunca se cambia su rama. */
  repoPath: z.string().min(1),
  /** Por defecto `C:\dev\.worktrees\<proyecto>`. Absoluta, fuera del repo y de las carpetas del sistema (`worktreesRootProblem`). */
  worktreesRoot: absoluteDirSchema.optional(),
  /** `core.hooksPath` de los worktrees; por defecto `<worktreesRoot>\\_hooks`. */
  hooksDir: absoluteDirSchema.optional(),
  baseBranch: branchSchema.default('main'),
  integrationBranch: branchSchema.default(DEFAULT_INTEGRATION_BRANCH),
  /** Rutas de la copia principal que se enlazan en cada worktree (`node_modules`, `workbench`…). */
  links: z.array(relPathSchema).default([]),
  postCreate: z.array(commandSpecSchema).default([]),
  gate: z.array(commandSpecSchema).default([]),
});
export type WorkspaceProject = z.infer<typeof workspaceProjectSchema> & { worktreesRoot: string; hooksDir: string };
export type WorkspaceProjectInput = z.input<typeof workspaceProjectSchema>;

/** Motivo del rechazo de un gate vacío: la flota no integra sin verificación. */
export const GATE_REQUIRED = 'el gate es obligatorio: la flota no integra sin verificación';

/**
 * Configuración de worktrees que se guarda con un proyecto (`POST /projects`, campo `workspace`): la misma de
 * `compose({ workspaceProjects })` sin `id` ni `repoPath` (salen del proyecto), con al menos un comando de gate y
 * sin `hooksDir`: por REST no se elige dónde se escribe el `pre-push` (podría pisar `.git/hooks` de la copia del
 * usuario); queda en `<worktreesRoot>\_hooks`.
 */
export const projectWorkspaceSchema = workspaceProjectSchema
  .omit({ id: true, repoPath: true, hooksDir: true })
  .extend({ gate: z.array(commandSpecSchema).min(1, GATE_REQUIRED) });
export type ProjectWorkspace = z.infer<typeof projectWorkspaceSchema>;
export type ProjectWorkspaceInput = z.input<typeof projectWorkspaceSchema>;

/** Raíz por defecto de los worktrees de un proyecto: `C:\dev\.worktrees\<proyecto>`. */
export function defaultWorktreesRoot(projectId: string): string {
  return win32.join('C:\\dev\\.worktrees', projectId);
}

export class WorkspaceConfigError extends Error {
  override readonly name = 'WorkspaceConfigError';
}

/** Valida la configuración (dato externo) y completa los valores por defecto. */
export function parseWorkspaceProject(input: unknown): WorkspaceProject {
  const parsed = workspaceProjectSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkspaceConfigError(`configuración de worktrees no válida: ${z.prettifyError(parsed.error)}`);
  }
  const p = parsed.data;
  if (p.integrationBranch === p.baseBranch) {
    throw new WorkspaceConfigError('integrationBranch no puede ser la rama base del usuario');
  }
  const worktreesRoot = p.worktreesRoot ?? defaultWorktreesRoot(p.id);
  return { ...p, worktreesRoot, hooksDir: p.hooksDir ?? join(worktreesRoot, HOOKS_DIR) };
}

/**
 * Ruta física: la ruta real (`realpath`, junctions incluidas) del ancestro existente más cercano más el resto. Así
 * una ruta «de fuera» que pasa por una junction hacia la copia del usuario se ve donde de verdad está.
 */
export function physicalPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

/**
 * Carpeta git común (`git rev-parse --git-common-dir`) de un checkout, leída del disco con el formato de git: `.git`
 * carpeta (copia principal) o archivo `gitdir: …` con `commondir` dentro (worktree enlazado). Dos worktrees del
 * mismo repositorio dan la misma. Si no es un checkout reconocible, su ruta física.
 */
export function gitCommonDir(checkout: string): string {
  const dotGit = join(checkout, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return physicalPath(dotGit);
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (m?.[1]) {
      const gitdir = resolve(checkout, m[1]);
      let common = gitdir;
      try {
        common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
      } catch {
        /* sin commondir: el propio gitdir */
      }
      return physicalPath(common);
    }
  } catch {
    /* no es un checkout: la carpeta misma */
  }
  return physicalPath(checkout);
}

function samePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a);
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Carpetas del sistema donde nunca van worktrees (en ellas o debajo). */
function systemDirs(env: Readonly<Record<string, string | undefined>>): string[] {
  const names = ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData'];
  return [...new Set(names.map((n) => envValue(env, n)).filter((v): v is string => Boolean(v)))];
}

/** Por qué una raíz (léxica o física) no sirve, o `undefined`. */
function rootProblem(root: string, repo: string, env: Readonly<Record<string, string | undefined>>, label: string): string | undefined {
  const norm = root.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(norm) || norm === '') return `worktreesRoot (${label}) no puede ser la raíz de un volumen`;
  const sys = systemDirs(env).find((d) => isInside(root, d));
  if (sys) return `worktreesRoot (${label}) no puede estar en una carpeta del sistema (${sys})`;
  const drive = /^([A-Za-z]:)[\\/]/.exec(root)?.[1];
  const profile = envValue(env, 'USERPROFILE');
  if ((drive && samePath(root, `${drive}\\Users`)) || (profile && samePath(root, profile))) {
    return `worktreesRoot (${label}) no puede ser la carpeta de usuarios ni el perfil del usuario`;
  }
  if (isInside(root, repo)) return `worktreesRoot (${label}) no puede estar dentro de la copia del usuario`;
  if (isInside(repo, root)) return `worktreesRoot (${label}) no puede contener la copia del usuario (${repo})`;
  return undefined;
}

/**
 * Los worktrees van en una raíz propia: absoluta, que no sea la raíz de un volumen, ni una carpeta del sistema, ni la
 * carpeta de usuarios o el perfil, y sin solaparse con la copia del usuario (en ningún sentido). Se comprueba la ruta
 * escrita y la física (`physicalPath`). Devuelve el motivo del rechazo o `undefined`.
 */
export function worktreesRootProblem(
  p: Pick<WorkspaceProject, 'repoPath' | 'worktreesRoot'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (!isAbsoluteDir(p.worktreesRoot)) return `worktreesRoot (${p.worktreesRoot}) debe ser una ruta absoluta`;
  return (
    rootProblem(p.worktreesRoot, p.repoPath, env, p.worktreesRoot) ??
    rootProblem(physicalPath(p.worktreesRoot), physicalPath(p.repoPath), env, `${p.worktreesRoot}, ruta real ${physicalPath(p.worktreesRoot)}`)
  );
}

/** Rutas de un proyecto que no pueden solaparse con las de otro. */
export interface ProjectPaths {
  id: string;
  repoPath: string;
  worktreesRoot: string;
}

/**
 * Dos proyectos no comparten copia ni raíz de worktrees, ni una cuelga de la otra (léxica o físicamente): si no, la
 * guardia de un proyecto dejaría a la flota quitar worktrees del otro. Devuelve el motivo o `undefined`.
 */
export function projectsOverlapProblem(p: ProjectPaths, others: readonly ProjectPaths[]): string | undefined {
  const mine = [p.repoPath, p.worktreesRoot].flatMap((x) => [x, physicalPath(x)]);
  for (const o of others) {
    if (o.id === p.id) continue;
    const theirs = [o.repoPath, o.worktreesRoot].flatMap((x) => [x, physicalPath(x)]);
    if (mine.some((a) => theirs.some((b) => isInside(a, b) || isInside(b, a)))) {
      return `las rutas del proyecto ${p.id} (${p.repoPath}, ${p.worktreesRoot}) se solapan con las del proyecto ${o.id} (${o.repoPath}, ${o.worktreesRoot})`;
    }
  }
  return undefined;
}

/**
 * Comprueba lo que depende de `id` y `repoPath` (ramas distintas, `worktreesRoot` fuera de la copia) para la
 * configuración guardada de un proyecto. Devuelve el motivo del rechazo o `undefined` si sirve.
 */
export function projectWorkspaceProblem(id: string, repoPath: string, workspace: ProjectWorkspaceInput): string | undefined {
  try {
    return worktreesRootProblem(parseWorkspaceProject({ ...workspace, id, repoPath }));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
