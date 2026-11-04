/**
 * Guardia de herramientas del orquestador: segunda barrera además de `tools`, `disallowedTools`,
 * `allowedTools` y `permissionMode: 'dontAsk'`. Se engancha como hook `PreToolUse` (ve también las
 * llamadas de los subagentes). `canUseTool` aplica la misma regla por si otro modo de permisos lo consultara.
 *
 * - Solo herramientas permitidas: las propias, lectura (Read, Grep, Glob), subagentes (Agent/Task) y las de los
 *   servidores MCP de plugins declarados con `mcp__<servidor>__*`.
 * - `deny` se consulta en cada llamada (modo de la mente: en `plan`, `delegar` queda bloqueada aunque la sesión
 *   la hubiera permitido al arrancar en `auto`).
 * - La lectura queda dentro de la carpeta del proyecto y de las raíces extra (p. ej. el hub de skills, los adjuntos
 *   o, en `bypass`, las unidades locales), que también se leen en cada llamada; nunca toca archivos típicos de
 *   credenciales (.env, claves privadas…) ni las rutas de `denyPaths` (bóveda y base de datos del núcleo).
 * - Los subagentes no pueden pedir un modo de permisos más amplio ni ejecutarse en remoto.
 */
import path from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';

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
  /** Archivos o carpetas que nunca se leen, aunque queden dentro de una raíz (bóveda, base de datos). */
  denyPaths?: readonly string[];
  /** Bloqueo dinámico (se consulta en cada llamada): devuelve el motivo para negar la herramienta. */
  deny?: (toolName: string, input: unknown) => string | undefined;
  /** Módulo de rutas (inyectable para probar rutas de Windows o POSIX). */
  pathApi?: path.PlatformPath;
}

export interface ToolGuard {
  check(toolName: string, input: unknown): GuardDecision;
  hook: HookCallback;
  canUseTool: CanUseTool;
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** Modos de permiso que un subagente puede pedir (ninguno amplía lo que ya tiene la sesión). */
const SAFE_SUBAGENT_MODES = new Set(['default', 'dontAsk', 'plan']);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.?credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i;
const GLOB_CHARS = /[*?[\]{}]/;

export const DENY_DEFAULT = 'El orquestador no edita archivos ni ejecuta comandos: delega con la herramienta delegar.';

export function createToolGuard(opts: ToolGuardOptions): ToolGuard {
  const p = opts.pathApi ?? path;
  const allowed = new Set(opts.allowedTools.filter((t) => !t.endsWith('__*')));
  const prefixes = opts.allowedTools.filter((t) => t.endsWith('__*') && t.length > 3).map((t) => t.slice(0, -1));
  const cwd = p.resolve(opts.cwd);
  const extraRoots = opts.readRoots;
  const roots = (): string[] => [cwd, ...(typeof extraRoots === 'function' ? extraRoots() : (extraRoots ?? [])).map((r) => p.resolve(cwd, r))];
  const denied = (opts.denyPaths ?? []).map((d) => p.resolve(cwd, d));

  const within = (list: readonly string[], target: string) =>
    list.some((root) => {
      const rel = p.relative(root, target);
      return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
    });
  const inside = (target: string) => within(roots(), target);
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
    const normalized = raw.replace(/\\/g, '/');
    const fixed = normalized.split('/').reduce<{ parts: string[]; done: boolean }>(
      (acc, part) => (acc.done || GLOB_CHARS.test(part) ? { parts: acc.parts, done: true } : { parts: [...acc.parts, part], done: false }),
      { parts: [], done: false },
    ).parts.join('/');
    if (normalized.split('/').includes('..')) return { allow: false, reason: `${tool}: el patrón no puede salir del proyecto con «..».` };
    if (!fixed || !p.isAbsolute(fixed)) return { allow: true };
    return checkPath(fixed, tool);
  };

  const check = (toolName: string, input: unknown): GuardDecision => {
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
    if (SUBAGENT_TOOLS.has(toolName)) {
      if (args.mode !== undefined && !SAFE_SUBAGENT_MODES.has(String(args.mode))) {
        return { allow: false, reason: `Un subagente no puede usar el modo ${String(args.mode)}.` };
      }
      if (args.isolation === 'remote') return { allow: false, reason: 'Los subagentes del orquestador corren en local.' };
    }
    return { allow: true };
  };

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = check(input.tool_name, input.tool_input);
    if (decision.allow) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } };
  };

  const canUseTool: CanUseTool = async (toolName, input) => {
    const decision = check(toolName, input);
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
  };

  return { check, hook, canUseTool };
}
