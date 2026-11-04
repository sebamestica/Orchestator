import { spawn } from 'node:child_process';
import { assertSafeGitArgs } from './guard.ts';
import type { GitGuardContext } from './guard.ts';
import { childEnv } from '../process/child-env.ts';
import { findOnPath, type LaunchTrust } from './commands.ts';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class GitError extends Error {
  override readonly name = 'GitError';
  readonly args: readonly string[];
  readonly result: GitResult;
  constructor(message: string, args: readonly string[], result: GitResult) {
    super(message);
    this.args = args;
    this.result = result;
  }
}

export interface GitRunOptions {
  /** Si es `false`, un código distinto de 0 no lanza: se devuelve el resultado. */
  check?: boolean;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

export interface GitRunnerOptions {
  /** Ejecutable de git (por defecto `git` del PATH). */
  gitPath?: string;
  /** Copias del usuario que la guardia protege. */
  protectedPaths?: readonly string[];
  allowedPaths?: readonly string[];
  /** Raíces de worktrees del orquestador (límite de `worktree remove`); git nunca se toma de ahí. */
  managedRoots?: readonly string[];
  defaultTimeoutMs?: number;
  /** Para buscar git en el PATH (por defecto el entorno y el disco del núcleo; inyectable en pruebas). */
  trust?: LaunchTrust;
}

export type GitRunner = (cwd: string, args: readonly string[], opts?: GitRunOptions) => Promise<GitResult>;

const MAX_OUTPUT = 1_000_000;

/**
 * Entorno de git: el de `childEnv` (sin claves) **sin ninguna `GIT_*` heredada** (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_CONFIG_*`, `GIT_INDEX_FILE`… cambiarían destino o config) y con las fijas del módulo.
 */
export function gitEnv(extra: Readonly<Record<string, string>> = {}, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  // Se quitan las GIT_* **heredadas**; las del llamador ya pasaron por la guardia (solo identidad del commit).
  const inherited = Object.fromEntries(Object.entries(childEnv({}, base)).filter(([name]) => !/^GIT_/i.test(name)));
  return { ...inherited, ...extra, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C' };
}

/** Lanza git sin shell y captura su salida. No pasa por la guardia: úsalo a través de `createGitRunner`. */
function spawnGit(gitPath: string, cwd: string, args: readonly string[], timeoutMs: number, env?: Readonly<Record<string, string>>): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(gitPath, args, {
      cwd,
      env: gitEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (cur: string, chunk: Buffer) => (cur.length >= MAX_OUTPUT ? cur : cur + chunk.toString('utf8'));
    child.stdout.on('data', (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = append(stderr, c); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}spawn error: ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Ejecutor de git del módulo: cada llamada pasa antes por `assertSafeGitArgs`.
 * Lanza `GitError` si git termina con código distinto de 0 (salvo `check: false`).
 */
export function createGitRunner(opts: GitRunnerOptions = {}): GitRunner {
  // Ruta absoluta del PATH del núcleo: git corre con el cwd en worktrees, y en Windows `spawn` sin shell busca
  // primero en el cwd (un `git.exe` versionado por un agente se lanzaría en su lugar). Sin un git confiable, falla
  // cerrado: nunca se lanza `git` a secas.
  const gitPath = opts.gitPath ?? findOnPath('git', opts.trust ?? {}, opts.managedRoots ?? []);
  const defaultTimeout = opts.defaultTimeoutMs ?? 120_000;
  return async (cwd, args, runOpts = {}) => {
    const guard: GitGuardContext = { cwd, protectedPaths: opts.protectedPaths, allowedPaths: opts.allowedPaths, managedRoots: opts.managedRoots, env: runOpts.env };
    assertSafeGitArgs(args, guard);
    if (!gitPath) {
      throw new GitError('git no está en el PATH del núcleo fuera de las carpetas de los agentes: no se lanza (nunca se busca en el worktree)', args, { code: null, stdout: '', stderr: '', timedOut: false });
    }
    const result = await spawnGit(gitPath, cwd, args, runOpts.timeoutMs ?? defaultTimeout, runOpts.env);
    if (runOpts.check !== false && result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-5).join(' | ');
      const why = result.timedOut ? 'tiempo agotado' : `código ${String(result.code)}`;
      throw new GitError(`git ${args.join(' ')} falló (${why}): ${detail}`, args, result);
    }
    return result;
  };
}
