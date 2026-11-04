import { resolve } from 'node:path';
import { ALLOWED_GLOBALS, NESTED, RULES } from './guard-rules.ts';
import type { ParsedForm, SubcommandRule } from './guard-rules.ts';

/** Error que lanza la guardia cuando una invocación de git está prohibida. */
export class GitGuardError extends Error {
  override readonly name = 'GitGuardError';
  readonly args: readonly string[];
  constructor(message: string, args: readonly string[]) {
    super(message);
    this.args = args;
  }
}

export interface GitGuardContext {
  /** Carpeta desde la que se ejecuta git. */
  cwd: string;
  /** Copias del usuario (repoPath de cada proyecto): ahí solo se permiten órdenes que no tocan su árbol. */
  protectedPaths?: readonly string[];
  /** Carpetas dentro de una copia protegida donde sí se permite todo lo de la lista blanca. */
  allowedPaths?: readonly string[];
  /** Raíces de worktrees del orquestador: `worktree remove` solo actúa dentro de ellas. */
  managedRoots?: readonly string[];
  /** Variables extra que el llamador quiere pasar a git: ninguna `GIT_*` (cambian config o destino). */
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}

function normPath(p: string, platform: NodeJS.Platform): string {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
}

/** `child` es `parent` o cuelga de él. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normPath(child, platform);
  const p = normPath(parent, platform);
  const sep = platform === 'win32' ? '\\' : '/';
  return c === p || c.startsWith(p + sep);
}

/** Separa opciones y posicionales según la regla; devuelve el motivo si alguna opción no está permitida. */
function parseForm(rule: SubcommandRule, rest: readonly string[]): ParsedForm | string {
  const options: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--') {
      if (!rule.dashDash) return '«--» no permitido aquí';
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (rule.flags?.includes(arg)) options.push(arg);
    else if (rule.valued?.includes(arg)) {
      const value = rest[i + 1];
      if (value === undefined) return `«${arg}» sin valor`;
      options.push(arg);
      i += 1;
    } else if (rule.prefixed?.some((p) => arg.startsWith(p))) options.push(arg);
    else return `opción no permitida «${arg}»`;
  }
  if (positionals.length > rule.maxPositionals) return 'demasiados argumentos';
  if (positionals.length < (rule.minPositionals ?? 0)) return 'faltan argumentos';
  return { options, positionals };
}

/**
 * Guardia de git del módulo (lista blanca). Niega:
 * - toda opción global que cambie configuración o destino (`-c`, `--config-env`, `-C`, `--git-dir`,
 *   `--work-tree`, `--exec-path`…) y toda variable `GIT_*` del llamador (`GIT_DIR`, `GIT_CONFIG_*`…);
 * - todo subcomando u opción fuera de `RULES` (push, rebase, reset, clean, checkout, switch, read-tree…);
 * - `merge`/`commit` en la copia del usuario y `worktree remove` fuera de las raíces del orquestador.
 */
const GIT_IDENTITY_ENV: ReadonlySet<string> = new Set(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']);

export function assertSafeGitArgs(args: readonly string[], ctx: GitGuardContext): void {
  const platform = ctx.platform ?? process.platform;
  const deny = (why: string): never => {
    throw new GitGuardError(`git bloqueado por la guardia: ${why} (git ${args.join(' ')})`, args);
  };
  for (const name of Object.keys(ctx.env ?? {})) {
    // Solo la identidad del commit (autor y quien confirma): no cambia configuración, destino ni repositorio.
    if (/^GIT_/i.test(name) && !GIT_IDENTITY_ENV.has(name.toUpperCase())) deny(`variable de entorno ${name} no permitida`);
  }
  if (args.some((a) => a.includes('\0'))) deny('argumento con NUL');

  let i = 0;
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const g = args[i] ?? '';
    if (!ALLOWED_GLOBALS.has(g)) deny(`opción global «${g}» no permitida`);
    i += 1;
  }
  const sub = args[i];
  if (sub === undefined) return deny('falta el subcomando');
  let key = sub;
  let rest = args.slice(i + 1);
  if (NESTED.has(sub)) {
    key = `${sub} ${rest[0] ?? ''}`;
    rest = rest.slice(1);
  }
  const rule = RULES[key];
  if (!rule) return deny(`«${key}» no está en la lista blanca`);
  const form = parseForm(rule, rest);
  if (typeof form === 'string') return deny(`${key}: ${form}`);
  const why = rule.check?.(form);
  if (why) deny(`${key}: ${why}`);

  if (key === 'worktree remove' && ctx.managedRoots) {
    const target = resolve(ctx.cwd, form.positionals[0] ?? '');
    if (!ctx.managedRoots.some((root) => isInside(target, root, platform) && !isInside(root, target, platform))) {
      deny(`«worktree remove» fuera de las raíces del orquestador (${target})`);
    }
  }
  if (rule.inUserCheckout) return;
  const allowed = (ctx.allowedPaths ?? []).some((p) => isInside(ctx.cwd, p, platform));
  if (!allowed && (ctx.protectedPaths ?? []).some((p) => isInside(ctx.cwd, p, platform))) {
    deny(`«${key}» en la copia del usuario (${ctx.cwd})`);
  }
}
