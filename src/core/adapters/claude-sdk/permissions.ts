import path from 'node:path';
import type { CanUseTool, HookCallbackMatcher, HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ShellKind } from './shell-parse.ts';
import { lexicallyInside, shellCommandProblem, writeProblem } from './shell-policy.ts';

/**
 * Política de herramientas del worker Claude (PLAN §4.8), aplicada en un hook `PreToolUse` del host.
 *
 * Por qué un hook: según la documentación del SDK (code.claude.com/docs/en/agent-sdk/permissions,
 * consultada el 2026-11-01) el orden es hooks → reglas deny → reglas ask → modo de permisos →
 * reglas allow → `canUseTool`. Las reglas allow (`.claude/settings.json`) y `acceptEdits` aprueban antes
 * de `canUseTool`; un hook corre antes que todo y su deny vale incluso en `bypassPermissions`.
 *
 * Denegación por defecto. Solo se permiten:
 * - lectura (`Read`, `Grep`, `Glob`, `LS`) dentro del worktree o de las rutas de lectura autorizadas;
 * - edición (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) si la ruta real (sigue junctions y enlaces)
 *   queda dentro del worktree y no es `.git`, `.claude/` ni `.mcp.json`;
 * - `Bash` y `PowerShell` según `shell-policy.ts` (ver su riesgo residual: sin aislamiento del sistema
 *   operativo, un script del worktree puede escribir fuera);
 * - subagentes y tareas (`Agent`, `Task`, `TodoWrite`, `Task*`), cuyas llamadas pasan también por el hook;
 * - las herramientas que se configuren a mano en `extraTools` (MCP propias, `WebFetch`…);
 * - las de los servidores MCP que entrega el orquestador (plugins de F5) por nombre exacto en `mcpServers`:
 *   `mcp__<servidor>__<herramienta>` y nada más (ni recursos MCP ni otros servidores).
 */

export interface ToolPolicyOptions {
  /** Carpetas o archivos que se pueden leer además del worktree (skills, notas de memoria). */
  readRoots?: readonly string[];
  /** Herramientas permitidas a mano; `mcp__servidor__*` permite todas las de un servidor configurado. */
  extraTools?: readonly string[];
  /** Carpeta actual de la sesión (la del hook); las rutas relativas se resuelven contra ella. */
  cwd?: string;
  /** Servidores MCP de los plugins (nombres sin `_`): se permiten sus herramientas `mcp__<servidor>__*`. */
  mcpServers?: readonly string[];
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS: Readonly<Record<string, ShellKind>> = { Bash: 'bash', PowerShell: 'powershell' };
const FREE_TOOLS = new Set(['Agent', 'Task', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function deny(reason: string): PermissionResult {
  return { behavior: 'deny', message: `Bloqueado por el orquestador: ${reason}. Si de verdad hace falta, propónlo en tu informe en lugar de ejecutarlo.` };
}

/** Problema si `target` no se puede leer (fuera del worktree y de las rutas autorizadas). */
function readProblem(worktree: string, cwd: string, roots: readonly string[], target: string): string | undefined {
  const abs = path.resolve(cwd, target);
  if (lexicallyInside(worktree, abs)) return undefined;
  if (roots.some((r) => lexicallyInside(path.resolve(r), abs))) return undefined;
  return `lectura fuera del worktree: ${abs}`;
}

/** Parte fija (sin comodines) de un patrón de Glob. */
function globBase(pattern: string): string {
  const k = pattern.search(/[*?[{]/);
  return (k < 0 ? pattern : pattern.slice(0, k)) || '.';
}

function toolAllowedByConfig(toolName: string, extraTools: readonly string[]): boolean {
  return extraTools.some((t) => t === toolName || (t.endsWith('*') && t.length > 1 && toolName.startsWith(t.slice(0, -1))));
}

/** Herramienta de uno de los servidores MCP entregados: `mcp__<servidor>__<herramienta>`, con el servidor exacto. */
export function mcpToolAllowed(toolName: string, servers: readonly string[]): boolean {
  const m = /^mcp__([a-z0-9][a-z0-9-]{0,40})__([A-Za-z0-9_-]{1,128})$/.exec(toolName);
  return m?.[1] !== undefined && servers.includes(m[1]);
}

/** Decide una llamada a herramienta. Nunca lanza: ante la duda, deniega. */
export async function decideToolUse(worktreePath: string, toolName: string, input: Record<string, unknown>, opts: ToolPolicyOptions = {}): Promise<PermissionResult> {
  const wt = path.resolve(worktreePath);
  const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
  try {
    const cwd = opts.cwd ? path.resolve(wt, opts.cwd) : wt;
    if (!lexicallyInside(wt, cwd)) return deny(`la sesión trabaja fuera del worktree (${cwd})`);
    const shell = SHELL_TOOLS[toolName];
    if (shell) {
      const command = str(input.command);
      if (!command) return deny('falta el comando');
      const problem = await shellCommandProblem(command, shell, wt, cwd);
      return problem ? deny(problem) : allow;
    }
    if (EDIT_TOOLS.has(toolName)) {
      const file = str(input.file_path) ?? str(input.notebook_path);
      if (!file) return deny('falta la ruta del archivo');
      const problem = await writeProblem(wt, path.resolve(cwd, file));
      return problem ? deny(problem) : allow;
    }
    if (toolName === 'Agent' || toolName === 'Task') {
      if (input.isolation !== undefined && input.isolation !== 'none') return deny('los subagentes con worktree propio salen del worktree de la tarea');
      const dir = str(input.cwd);
      if (dir && !lexicallyInside(wt, path.resolve(cwd, dir))) return deny(`subagente con carpeta fuera del worktree (${dir})`);
      return allow;
    }
    if (READ_TOOLS.has(toolName)) {
      const roots = opts.readRoots ?? [];
      const dir = str(input.path) ?? '.';
      let targets: string[];
      if (toolName === 'Read') {
        const file = str(input.file_path);
        if (!file) return deny('falta la ruta del archivo');
        targets = [file];
      } else if (toolName === 'Glob') {
        const base = globBase(str(input.pattern) ?? '.');
        targets = [dir, path.isAbsolute(base) ? base : path.join(dir, base)];
      } else {
        targets = [dir];
      }
      for (const t of targets) {
        const problem = readProblem(wt, cwd, roots, t);
        if (problem) return deny(problem);
      }
      return allow;
    }
    if (FREE_TOOLS.has(toolName)) return allow;
    if (toolAllowedByConfig(toolName, opts.extraTools ?? [])) return allow;
    if (mcpToolAllowed(toolName, opts.mcpServers ?? [])) return allow;
    return deny(`herramienta no permitida: ${toolName}`);
  } catch (err) {
    return deny(`error al evaluar la política (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** `canUseTool` con la misma política: respaldo para las llamadas que llegan hasta él. */
export function createToolPolicy(worktreePath: string, opts: ToolPolicyOptions = {}): CanUseTool {
  return async (toolName, input) => decideToolUse(worktreePath, toolName, input, opts);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Hook `PreToolUse` del host con la política: decide `allow` o `deny` para cada llamada, también las
 * de los subagentes. Falla cerrado: una entrada inválida o un error deniegan.
 */
export function createPolicyHook(worktreePath: string, opts: ToolPolicyOptions = {}): HookCallbackMatcher {
  return {
    timeout: 60,
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const decision = isRecord(input.tool_input)
          ? await decideToolUse(worktreePath, input.tool_name, input.tool_input, { ...opts, cwd: input.cwd || worktreePath })
          : deny('entrada de la herramienta inválida');
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.behavior,
            permissionDecisionReason: decision.behavior === 'deny' ? decision.message : 'Permitido por la política del orquestador.',
          },
        };
      },
    ],
  };
}

export { lexicallyInside as isInside };
