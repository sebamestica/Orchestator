/**
 * `git` de Berland para agy (issue autoeval-reglas-04). agy corre con `--dangerously-skip-permissions` y, comprobado
 * en vivo el 2026-11-05, ese modo ignora las reglas `deny` de `command(...)` de `--settings`. Para que sus órdenes git
 * pasen por la misma política que los workers Claude (`gitArgvProblem`: sin `push`, `-c`, `-C` fuera del worktree,
 * `config`, `remote`, alias…), el adaptador escribe `<worktree>\.orq\bin\git.cmd` y pone esa carpeta primera en el
 * `PATH` de agy. El `.cmd` llama a este archivo con Node:
 *
 *   node git-shim.ts <git.exe real> <worktree> <args de git…>
 *
 * Si la política lo permite, lanza el `git.exe` real con los mismos argumentos y devuelve su código; si no, sale con 1
 * y el motivo en stderr. El git real corre sin las variables `GIT_*` heredadas (salvo `GIT_AUTHOR_*` y
 * `GIT_COMMITTER_*`): `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, `GIT_CONFIG_PARAMETERS` o `GIT_DIR`
 * meterían configuración o cambiarían de repositorio sin pasar por la política.
 *
 * El `^` no llega: el `.cmd` pasa los argumentos con `%*` y cmd se come los `^` (`HEAD^` llega como `HEAD`). Por eso el
 * encargo de agy le pide `HEAD~1` en vez de `^`.
 *
 * RIESGO RESIDUAL: corta errores y usos normales, no a un agente decidido. Llamar a `git.exe` por su ruta completa,
 * desde Git Bash (no ejecuta `.cmd`) o editar este `.cmd` lo salta.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitArgvProblem } from '../claude-sdk/shell-policy.ts';

export const GIT_SHIM_SCRIPT = fileURLToPath(import.meta.url);

type Env = Readonly<Record<string, string | undefined>>;

const pathKey = (env: Env) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH');

/** Valor del `PATH` (en Windows la clave puede ser `Path`). */
export function pathValue(env: Env): string | undefined {
  const key = pathKey(env);
  return key ? env[key] : undefined;
}

/** Primer `git.exe` de las carpetas absolutas del `PATH`. */
export function findRealGit(path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const exe = join(dir, 'git.exe');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

/** Comillas de cmd: `%` se duplica para que el `.cmd` no lo expanda. */
const cmdQuote = (s: string) => `"${s.replace(/%/g, '%%')}"`;

export function gitShimCmd(o: { node: string; script: string; realGit: string; worktree: string }): string {
  return `@${[o.node, o.script, o.realGit, o.worktree].map(cmdQuote).join(' ')} %*\r\n`;
}

/**
 * Escribe el `git.cmd` de la tarea y devuelve el entorno de agy con su carpeta primera en el `PATH`. Sin `git.exe` en el
 * `PATH` (o fuera de Windows) devuelve el entorno tal cual: agy tampoco tendría git.
 */
export async function withGitShim(worktree: string, env: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const path = pathValue(env) ?? pathValue(process.env);
  const realGit = process.platform === 'win32' ? findRealGit(path) : undefined;
  if (!realGit) return { ...env };
  const dir = join(worktree, '.orq', 'bin');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'git.cmd'), gitShimCmd({ node: process.execPath, script: GIT_SHIM_SCRIPT, realGit, worktree }), 'utf8');
  // Misma clave que el entorno del núcleo: `childEnv` la pisa en vez de dejar `Path` y `PATH` a la vez.
  const key = pathKey(env) ?? pathKey(process.env) ?? 'PATH';
  return { ...env, [key]: path ? `${dir}${delimiter}${path}` : dir };
}

/** Entorno del git real: sin las `GIT_*` heredadas, salvo la autoría (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`). */
export function gitShimEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') && !upper.startsWith('GIT_AUTHOR_') && !upper.startsWith('GIT_COMMITTER_')) continue;
    out[key] = value;
  }
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  const [realGit, worktree, ...args] = argv;
  if (!realGit || !worktree) {
    process.stderr.write('Uso: node git-shim.ts <git.exe real> <worktree> <args de git…>\n');
    return 2;
  }
  const problem = await gitArgvProblem(args, worktree, process.cwd());
  if (problem) {
    process.stderr.write(`berland: git bloqueado en este worktree: ${problem}\n`);
    return 1;
  }
  const run = spawnSync(realGit, args, { stdio: 'inherit', windowsHide: true, env: gitShimEnv(process.env) });
  if (run.error) process.stderr.write(`berland: no se pudo lanzar git: ${run.error.message}\n`);
  return run.status ?? 1;
}

function isEntry(): boolean {
  try {
    const entry = process.argv[1];
    return entry !== undefined && realpathSync(entry) === realpathSync(GIT_SHIM_SCRIPT);
  } catch {
    return false;
  }
}

if (isEntry()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
