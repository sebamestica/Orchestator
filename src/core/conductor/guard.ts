/**
 * Guardia de herramientas del orquestador: segunda barrera además de `tools`, `disallowedTools`,
 * `allowedTools` y `permissionMode: 'dontAsk'`. Se engancha como hook `PreToolUse` (ve también las
 * llamadas de los subagentes). `canUseTool` aplica la misma regla por si otro modo de permisos lo consultara.
 *
 * - Solo herramientas permitidas: las propias, lectura (Read, Grep, Glob), subagentes (Agent/Task), las de los
 *   servidores MCP de plugins declarados con `mcp__<servidor>__*` y, en `bypass`, edición y shell.
 * - `deny` se consulta en cada llamada (modo de la mente: en `plan`, `delegar` queda bloqueada aunque la sesión
 *   la hubiera permitido al arrancar en `auto`; fuera de `bypass`, edición y shell).
 * - La lectura queda dentro de la carpeta del proyecto y de las raíces extra (p. ej. el hub de skills, los adjuntos
 *   o, en `bypass`, las unidades locales), que también se leen en cada llamada; nunca toca archivos típicos de
 *   credenciales (.env, claves privadas…) ni las rutas de `denyPaths` (bóveda y base de datos del núcleo). `decide`
 *   lo comprueba también con la ruta real (sigue junctions y enlaces): una junction del proyecto no saca la lectura
 *   de las raíces ni llega a `denyPaths` por otro nombre.
 * - Edición (Edit, Write, NotebookEdit): solo dentro de `writeRoots` (en `bypass`, el proyecto y las carpetas extra
 *   del chat), con la ruta real (sigue junctions y enlaces), nunca en `.git`, `.claude/`, `.mcp.json`, archivos de
 *   credenciales ni `denyPaths`.
 * - Shell (Bash, PowerShell): cada comando pasa por la política de los workers (`shell-policy.ts`) con `shellRoot`
 *   como raíz: niega push, despliegue, rebase, `reset --hard`, borrar ramas, escribir fuera del proyecto… `shellRoot`
 *   es la carpeta real del usuario, así que además git no fusiona, no mueve la rama ni descarta cambios (`userCopy`).
 *   Lo que la sesión baja de internet no lo ejecuta (`shell-downloads.ts`). Ver su riesgo residual: sin aislamiento
 *   del sistema operativo, un script del proyecto puede escribir fuera.
 * - Subagentes: con `subagentTypes`, solo esos tipos y con `subagent_type` explícito (el SDK suma sus integrados, como
 *   `general-purpose`, que es el tipo por omisión). No pueden pedir un modo de permisos más amplio ni ejecutarse en
 *   remoto (ni en un worktree propio). Con `backgroundSubagents`, el hook los lanza siempre en segundo plano.
 * - Chrome personal (`mcp__chrome-personal__*`): solo navega a http(s) y `about:blank` (nunca `file:`, `view-source:`,
 *   `data:`…); los archivos que sube pasan por las mismas reglas de lectura, y los que guarda (capturas, volcados,
 *   trazas) quedan dentro de `writeRoots`. Así lo que Read tiene negado no se lee por el navegador.
 */
import path from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { parseShell, type ShellKind } from '../adapters/claude-sdk/shell-parse.ts';
import { sessionShellProblem } from '../adapters/claude-sdk/shell-downloads.ts';
import { leadingCdTarget, lexicallyInside, writeProblem } from '../adapters/claude-sdk/shell-policy.ts';
import { realOrNearest } from '../memory/safe-fs.ts';
import { chromeToolOf, chromeToolWrites, isPathArg, isUrlArg, isWebScheme, urlScheme } from './plugin-policy.ts';

export type GuardDecision = { allow: true } | { allow: false; reason: string };

export interface ToolGuardOptions {
  /**
   * Nombres permitidos (los `mcp__…` propios, Read, Grep, Glob, Agent…). Un nombre que termina en `__*`
   * (`mcp__chrome__*`) permite todas las herramientas de ese servidor MCP.
   */
  allowedTools: readonly string[];
  /** Carpeta del proyecto: las rutas relativas se resuelven desde aquí. */
  cwd: string;
  /** Carpetas extra que se pueden leer (además de `cwd`). Con una función, se leen en cada llamada. */
  readRoots?: readonly string[] | (() => readonly string[]);
  /** Archivos o carpetas que nunca se leen ni se escriben, aunque queden dentro de una raíz (bóveda, base de datos). */
  denyPaths?: readonly string[];
  /** Bloqueo dinámico (se consulta en cada llamada): devuelve el motivo para negar la herramienta. */
  deny?: (toolName: string, input: unknown) => string | undefined;
  /**
   * Carpetas donde Edit, Write y NotebookEdit pueden escribir (en `bypass`: el proyecto y las carpetas extra del chat).
   * Sin ellas, la edición se niega aunque la herramienta esté permitida. Con una función, se leen en cada llamada.
   */
  writeRoots?: readonly string[] | (() => readonly string[]);
  /**
   * Raíz de Bash y PowerShell (en `bypass`: la carpeta del proyecto). Cada comando pasa por la política de shell de
   * los workers con esta raíz; sin ella, el shell se niega aunque la herramienta esté permitida.
   */
  shellRoot?: string;
  /**
   * Módulo de rutas (inyectable para probar rutas de Windows o POSIX). La edición y el shell comprueban la ruta real
   * en disco con el módulo del sistema.
   */
  pathApi?: path.PlatformPath;
  /**
   * Tipos de subagente que se pueden lanzar (los de `Options.agents`). Con la lista, `Agent`/`Task` exige un
   * `subagent_type` de ella: sin él, el SDK lanza su `general-purpose` con todas las herramientas de la sesión.
   */
  subagentTypes?: readonly string[];
  /**
   * Subagentes siempre en segundo plano (issue mente-10): el hook devuelve el `Agent`/`Task` permitido con
   * `run_in_background: true`. Un subagente en primer plano deja a la mente bloqueada hasta que termina, y un mensaje
   * del usuario a mitad de turno espera todo ese rato sin respuesta.
   */
  backgroundSubagents?: boolean;
}

export interface ToolGuard {
  /**
   * Decisión síncrona: lectura, subagentes, MCP y herramientas no permitidas. La edición y el shell necesitan el disco
   * o la política de shell, así que aquí se niegan siempre: decídelas con `decide`. La lectura se comprueba solo con el
   * texto de la ruta (no sigue junctions ni enlaces); `decide` añade la ruta real.
   */
  check(toolName: string, input: unknown): GuardDecision;
  /** Decisión completa (la del hook y `canUseTool`). `cwd`: carpeta actual de la sesión, la que trae el hook. */
  decide(toolName: string, input: unknown, cwd?: string): Promise<GuardDecision>;
  hook: HookCallback;
  canUseTool: CanUseTool;
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** Herramientas de edición y la propiedad con la ruta que escriben. */
const EDIT_TOOLS: Readonly<Record<string, string>> = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };
const SHELL_TOOLS: Readonly<Record<string, ShellKind>> = { Bash: 'bash', PowerShell: 'powershell' };
/** Modos de permiso que un subagente puede pedir (ninguno amplía lo que ya tiene la sesión). El SDK 0.3.302 ignora `mode`; se revisa por si vuelve a regir. */
const SAFE_SUBAGENT_MODES = new Set(['default', 'dontAsk', 'plan']);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.?credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i;
const GLOB_CHARS = /[*?[\]{}]/;

export const DENY_DEFAULT = 'Fuera del modo bypass el orquestador no edita archivos ni ejecuta comandos: delega con crear_tareas y delegar.';
/** Cola de los rechazos de shell: la mente busca otra vía sin rendirse ni saltarse la regla. */
const SHELL_HINT =
  'Busca otra vía dentro del proyecto sin esquivar la regla; push, despliegue, pagos, borrar ramas, reescribir la historia y mover la rama o descartar los cambios del usuario necesitan al usuario.';

const isEditOrShell = (name: string) => name in EDIT_TOOLS || name in SHELL_TOOLS;
/** Parte fija de un patrón glob (hasta el primer comodín), con barras `/`. */
const fixedPart = (pattern: string) => {
  const parts: string[] = [];
  for (const part of pattern.replace(/\\/g, '/').split('/')) {
    if (GLOB_CHARS.test(part)) break;
    parts.push(part);
  }
  return parts.join('/');
};
/** Texto normalizado (barras `/`, minúsculas) para buscar una ruta dentro de un comando. */
const comparable = (text: string) => text.replace(/\\/g, '/').toLowerCase();

/**
 * Textos que un comando no puede nombrar: cada ruta vetada (también como `/c/…` de Git Bash y `/mnt/c/…` de WSL) y su
 * carpeta (la de datos del núcleo), salvo que esa carpeta contenga al proyecto. Corta los caminos obvios (`type
 * C:\…\vault.json`, `cd <datos> && cat vault.json`); rutas relativas, variables o scripts quedan como riesgo residual.
 */
function shellDeniedText(denied: readonly string[], project: string): string[] {
  const out = new Set<string>();
  const add = (abs: string) => {
    const c = comparable(abs).replace(/\/+$/, '');
    if (c.length < 4) return;
    out.add(c);
    const drive = /^([a-z]):(\/.*)$/.exec(c);
    if (drive) {
      out.add(`/${drive[1]}${drive[2]}`);
      out.add(`/mnt/${drive[1]}${drive[2]}`);
    }
  };
  for (const d of denied) {
    add(d);
    const parent = path.dirname(d);
    if (parent !== d && path.dirname(parent) !== parent && !lexicallyInside(parent, project)) add(parent);
  }
  return [...out];
}

/**
 * True si `command` es un único `cd` que, desde `dir`, vuelve dentro de `root`. Con algo detrás no: si el cd falla
 * (`cd ROOT/no-existe; rm -rf *`), va en segundo plano (`cd ROOT & …`) o se salta (`cd ROOT || …`), lo que sigue
 * correría fuera del proyecto.
 */
function startsBackInside(command: string, kind: ShellKind, root: string, dir: string): boolean {
  if (parseShell(command, kind).commands.length !== 1) return false;
  const target = leadingCdTarget(command, kind, dir);
  return target !== undefined && lexicallyInside(root, target);
}

export function createToolGuard(opts: ToolGuardOptions): ToolGuard {
  const p = opts.pathApi ?? path;
  const allowed = new Set(opts.allowedTools.filter((t) => !t.endsWith('__*')));
  const prefixes = opts.allowedTools.filter((t) => t.endsWith('__*') && t.length > 3).map((t) => t.slice(0, -1));
  const cwd = p.resolve(opts.cwd);
  const listOf = (v: readonly string[] | (() => readonly string[]) | undefined) => (typeof v === 'function' ? v() : (v ?? []));
  const roots = (): string[] => [cwd, ...listOf(opts.readRoots).map((r) => p.resolve(cwd, r))];
  const writeRoots = (): string[] => listOf(opts.writeRoots).map((r) => path.resolve(opts.cwd, r));
  const subagentTypes = opts.subagentTypes ? new Set(opts.subagentTypes) : undefined;
  const shellRoot = opts.shellRoot === undefined ? undefined : path.resolve(opts.shellRoot);
  const denied = (opts.denyPaths ?? []).map((d) => p.resolve(cwd, d));
  const deniedOnDisk = (opts.denyPaths ?? []).map((d) => path.resolve(opts.cwd, d));
  const deniedText = shellDeniedText(deniedOnDisk, shellRoot ?? path.resolve(opts.cwd));
  /** Lo que esta sesión bajó de internet (también sus subagentes): no lo ejecuta. */
  const downloaded = new Set<string>();

  const within = (list: readonly string[], target: string) =>
    list.some((root) => {
      const rel = p.relative(root, target);
      return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
    });
  const inside = (target: string) => within(roots(), target);
  const insideWrite = (target: string) => within(listOf(opts.writeRoots).map((r) => p.resolve(cwd, r)), target);
  const isAllowed = (name: string) => allowed.has(name) || prefixes.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);

  const checkPath = (raw: unknown, tool: string): GuardDecision => {
    if (raw === undefined || raw === null || raw === '') return { allow: true };
    if (typeof raw !== 'string') return { allow: false, reason: `${tool}: ruta inválida.` };
    if (raw.includes('\0')) return { allow: false, reason: `${tool}: ruta inválida.` };
    const target = p.resolve(cwd, raw);
    if (!inside(target)) return { allow: false, reason: `${tool}: solo puedes leer dentro del proyecto (${cwd}) y de las carpetas extra.` };
    if (SENSITIVE_FILE.test(p.basename(target)) || within(denied, target)) {
      return { allow: false, reason: `${tool}: ese archivo puede contener credenciales; no se lee.` };
    }
    return { allow: true };
  };

  /** Parte fija de un patrón glob (hasta el primer comodín): si es absoluta, también debe quedar dentro. */
  const checkPattern = (raw: unknown, tool: string): GuardDecision => {
    if (typeof raw !== 'string') return { allow: true };
    const fixed = fixedPart(raw);
    if (raw.replace(/\\/g, '/').split('/').includes('..')) return { allow: false, reason: `${tool}: el patrón no puede salir del proyecto con «..».` };
    if (!fixed || !p.isAbsolute(fixed)) return { allow: true };
    return checkPath(fixed, tool);
  };

  /** Tipo de subagente permitido, sin modo más amplio, ni remoto ni en worktree propio. */
  const checkSubagent = (args: Record<string, unknown>): GuardDecision => {
    if (subagentTypes && !(typeof args.subagent_type === 'string' && subagentTypes.has(args.subagent_type))) {
      return { allow: false, reason: `Solo puedes lanzar estos subagentes: ${[...subagentTypes].join(', ')}. Indica subagent_type.` };
    }
    if (args.mode !== undefined && !SAFE_SUBAGENT_MODES.has(String(args.mode))) {
      return { allow: false, reason: `Un subagente no puede usar el modo ${String(args.mode)}.` };
    }
    if (args.isolation === 'remote') return { allow: false, reason: 'Los subagentes del orquestador corren en local.' };
    // Un worktree propio escribe en .git y en el proyecto (y corre sus hooks de git) aunque la sesión no edite.
    if (args.isolation === 'worktree') return { allow: false, reason: 'Los subagentes trabajan en la carpeta del proyecto, sin worktree propio.' };
    return { allow: true };
  };

  /** Argumentos del Chrome personal: URL web, archivos que sube (lectura) y archivos que guarda (escritura). */
  const chromeDecision = (tool: string, toolName: string, args: Record<string, unknown>): GuardDecision => {
    for (const [key, value] of Object.entries(args)) {
      if (isUrlArg(key)) {
        if (typeof value !== 'string' || !isWebScheme(urlScheme(value))) {
          return { allow: false, reason: `${toolName}: solo navegas a direcciones http(s) o about:blank; los archivos locales se leen con Read, dentro del proyecto.` };
        }
      } else if (isPathArg(key)) {
        const files: unknown = key.endsWith('Paths') ? value : [value];
        if (!Array.isArray(files)) return { allow: false, reason: `${toolName}: ${key} debe ser una lista de rutas.` };
        for (const file of files) {
          const read = checkPath(file, toolName);
          if (!read.allow) return read;
          if (chromeToolWrites(tool) && typeof file === 'string' && file !== '' && !insideWrite(p.resolve(cwd, file))) {
            return { allow: false, reason: `${toolName}: solo guardas archivos dentro del proyecto y de las carpetas extra del chat (modos bypass y chat); sin ${key}, el resultado vuelve en la respuesta.` };
          }
        }
      }
    }
    return { allow: true };
  };

  /** Parte síncrona común: herramienta permitida, bloqueo dinámico, lectura, subagentes y Chrome. */
  const precheck = (toolName: string, input: unknown): GuardDecision => {
    if (!isAllowed(toolName)) return { allow: false, reason: `${toolName} no está permitido. ${DENY_DEFAULT}` };
    const blocked = opts.deny?.(toolName, input);
    if (blocked) return { allow: false, reason: blocked };
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (READ_TOOLS.has(toolName)) {
      const pathCheck = checkPath(toolName === 'Read' ? args.file_path : args.path, toolName);
      if (!pathCheck.allow) return pathCheck;
      if (toolName === 'Glob') return checkPattern(args.pattern, toolName);
      if (toolName === 'Grep') return checkPattern(args.glob, toolName);
      return pathCheck;
    }
    if (SUBAGENT_TOOLS.has(toolName)) return checkSubagent(args);
    const chromeTool = chromeToolOf(toolName);
    if (chromeTool) return chromeDecision(chromeTool, toolName, args);
    return { allow: true };
  };

  const check = (toolName: string, input: unknown): GuardDecision => {
    const decision = precheck(toolName, input);
    if (decision.allow && isEditOrShell(toolName)) return { allow: false, reason: `${toolName} se decide con la política de escritura y de shell (decide).` };
    return decision;
  };

  /** Rutas en disco que abre una lectura: el archivo o la carpeta (por defecto, el proyecto) y la parte fija del patrón. */
  const readTargets = (toolName: string, args: Record<string, unknown>): string[] => {
    const main = toolName === 'Read' ? args.file_path : args.path;
    const dir = path.resolve(opts.cwd, typeof main === 'string' ? main : '');
    const pattern = toolName === 'Glob' ? args.pattern : toolName === 'Grep' ? args.glob : undefined;
    const fixed = typeof pattern === 'string' ? fixedPart(pattern) : '';
    return fixed ? [dir, path.resolve(dir, fixed)] : [dir];
  };

  /** Lectura con la ruta real: dentro de la ruta real de alguna raíz, fuera de `denyPaths` y sin credenciales. */
  const readDecision = async (toolName: string, args: Record<string, unknown>): Promise<GuardDecision> => {
    // Una raíz que no se puede resolver (unidad sin medio, sin permiso) no autoriza nada.
    const realRoots = (await Promise.all([opts.cwd, ...listOf(opts.readRoots)].map((r) => realOrNearest(path.resolve(opts.cwd, r)).catch(() => undefined))))
      .filter((r): r is string => r !== undefined);
    const realDenied = await Promise.all(deniedOnDisk.map((d) => realOrNearest(d).catch(() => d)));
    for (const target of readTargets(toolName, args)) {
      const real = await realOrNearest(target);
      if (!realRoots.some((root) => lexicallyInside(root, real))) {
        return { allow: false, reason: `${toolName}: la ruta real (sigue junctions y enlaces) sale del proyecto (${cwd}) y de las carpetas extra.` };
      }
      if (SENSITIVE_FILE.test(path.basename(real)) || realDenied.some((d) => lexicallyInside(d, real))) {
        return { allow: false, reason: `${toolName}: ese archivo puede contener credenciales; no se lee.` };
      }
    }
    return { allow: true };
  };

  const editDecision = async (toolName: string, args: Record<string, unknown>): Promise<GuardDecision> => {
    const raw = args[EDIT_TOOLS[toolName] as string];
    if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return { allow: false, reason: `${toolName}: falta la ruta del archivo o es inválida.` };
    const target = path.resolve(opts.cwd, raw);
    const candidates = writeRoots().filter((root) => lexicallyInside(root, target));
    if (!candidates.length) {
      return { allow: false, reason: `${toolName}: solo puedes escribir dentro del proyecto (${cwd}) y de las carpetas extra del chat.` };
    }
    if (SENSITIVE_FILE.test(path.basename(target)) || deniedOnDisk.some((d) => lexicallyInside(d, target))) {
      return { allow: false, reason: `${toolName}: no se escriben archivos de credenciales ni los datos del núcleo.` };
    }
    let problem: string | undefined;
    for (const root of candidates) {
      problem = await writeProblem(root, target);
      if (!problem) return { allow: true };
    }
    return { allow: false, reason: `${toolName}: ${problem ?? 'escritura no permitida'}.` };
  };

  const shellDecision = async (toolName: string, kind: ShellKind, args: Record<string, unknown>, at: string | undefined): Promise<GuardDecision> => {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) return { allow: false, reason: `${toolName}: falta el comando.` };
    if (!shellRoot) return { allow: false, reason: `${toolName} no está disponible en esta sesión.` };
    const dir = at ? path.resolve(shellRoot, at) : shellRoot;
    // Con la sesión afuera solo pasa un `cd` solo que vuelve al proyecto; lo demás, en el comando siguiente.
    if (!lexicallyInside(shellRoot, dir) && !startsBackInside(command, kind, shellRoot, dir)) {
      return { allow: false, reason: `${toolName}: la sesión trabaja fuera del proyecto (${dir}); vuelve primero con \`cd ${shellRoot}\`, solo, y sigue en el comando siguiente.` };
    }
    const text = comparable(command);
    if (deniedText.some((d) => text.includes(d))) return { allow: false, reason: `${toolName}: el comando nombra los datos del núcleo (bóveda o base de datos); no se tocan.` };
    const problem = await sessionShellProblem(command, kind, shellRoot, dir, downloaded, { userCopy: true });
    return problem ? { allow: false, reason: `${toolName} bloqueado por la guardia: ${problem}. ${SHELL_HINT}` } : { allow: true };
  };

  const decide = async (toolName: string, input: unknown, at?: string): Promise<GuardDecision> => {
    try {
      const decision = precheck(toolName, input);
      if (!decision.allow) return decision;
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      if (READ_TOOLS.has(toolName)) return await readDecision(toolName, args);
      if (!isEditOrShell(toolName)) return decision;
      const kind = SHELL_TOOLS[toolName];
      return kind ? await shellDecision(toolName, kind, args, at) : await editDecision(toolName, args);
    } catch (err) {
      // Falla cerrado: un error al evaluar niega.
      return { allow: false, reason: `${toolName}: error al evaluar la guardia (${err instanceof Error ? err.message : String(err)}).` };
    }
  };

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = await decide(input.tool_name, input.tool_input, input.cwd || undefined);
    if (decision.allow) {
      const args = input.tool_input;
      if (opts.backgroundSubagents && SUBAGENT_TOOLS.has(input.tool_name) && args && typeof args === 'object' && (args as Record<string, unknown>).run_in_background !== true) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...(args as Record<string, unknown>), run_in_background: true } } };
      }
      return {};
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } };
  };

  const canUseTool: CanUseTool = async (toolName, input) => {
    const decision = await decide(toolName, input);
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
  };

  return { check, decide, hook, canUseTool };
}
