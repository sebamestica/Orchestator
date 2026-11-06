import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { GitRunner } from './git.ts';

/** URL inválida a la que se redirige todo push desde un worktree del orquestador. */
export const BLOCKED_PUSH_URL = 'orquestador-bloqueado://sin-push';
/** `remote.pushDefault` de los worktrees: un remoto que no existe. */
export const BLOCKED_REMOTE = 'orquestador-bloqueado';

const PRE_PUSH = [
  '#!/bin/sh',
  '# Generado por el orquestador: los worktrees de tareas no hacen push.',
  'echo "orquestador: push bloqueado en este worktree (lo integra el orquestador)" >&2',
  'exit 1',
  '',
].join('\n');

async function lstatOrUndefined(p: string) {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Carpeta de hooks del orquestador con un `pre-push` que siempre rechaza. Nunca escribe a través de un enlace ni pisa
 * nada ajeno: si la carpeta ya existe, tiene que ser una carpeta real (no junction ni enlace) con solo nuestro
 * `pre-push` (archivo propio, sin enlaces duros, con el mismo contenido); si no, falla sin escribir.
 */
export async function ensureHooksDir(dir: string): Promise<string> {
  const hook = join(dir, 'pre-push');
  const st = await lstatOrUndefined(dir);
  if (!st) {
    await mkdir(dir, { recursive: true });
  } else {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} existe y no es una carpeta del orquestador (enlace, junction o archivo): no se escribe pre-push`);
    const extra = (await readdir(dir)).filter((name) => name !== 'pre-push');
    if (extra.length > 0) throw new Error(`${dir} tiene archivos ajenos (${extra.slice(0, 5).join(', ')}): no es la carpeta de hooks del orquestador`);
    const hs = await lstatOrUndefined(hook);
    if (hs) {
      await assertOwnHook(hook);
      return dir;
    }
  }
  // `wx`: si alguien lo crea entre la comprobación y la escritura, falla en lugar de pisarlo; y lo que apareció se
  // acepta solo si pasa las mismas comprobaciones (archivo propio, sin enlaces, mismo contenido).
  try {
    await writeFile(hook, PRE_PUSH, { encoding: 'utf8', mode: 0o755, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    await assertOwnHook(hook);
  }
  return dir;
}

/** El `pre-push` existente es nuestro: archivo normal (ni enlace ni junction), sin enlaces duros y con el mismo texto. */
async function assertOwnHook(hook: string): Promise<void> {
  const hs = await lstat(hook);
  if (hs.isSymbolicLink() || !hs.isFile() || hs.nlink > 1) throw new Error(`${hook} no es el pre-push del orquestador (enlace o archivo compartido): no se sobrescribe`);
  if ((await readFile(hook, 'utf8')) !== PRE_PUSH) throw new Error(`${hook} ya existe con otro contenido: no se sobrescribe`);
}

async function getConfig(git: GitRunner, cwd: string, scope: '--local' | '--worktree', key: string): Promise<string | undefined> {
  const r = await git(cwd, ['config', scope, '--get', key], { check: false });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * Habilita `extensions.worktreeConfig` en el repo (única línea que cambia en la config común) para
 * que `git config --worktree` escriba en `config.worktree` del worktree y no en la copia del usuario.
 */
export async function enableWorktreeConfig(git: GitRunner, worktreePath: string): Promise<void> {
  const current = await getConfig(git, worktreePath, '--local', 'extensions.worktreeConfig');
  if (current === 'true') return;
  // Con la extensión activa, core.bare/core.worktree de la config común dejarían de aplicarse bien.
  if (await getConfig(git, worktreePath, '--local', 'core.worktree')) {
    throw new Error('el repo define core.worktree: no se habilita extensions.worktreeConfig (bloqueo de push imposible)');
  }
  if ((await getConfig(git, worktreePath, '--local', 'core.bare')) === 'true') {
    throw new Error('repo bare: no se habilita extensions.worktreeConfig');
  }
  await git(worktreePath, ['config', '--local', 'extensions.worktreeConfig', 'true']);
}

/**
 * Defensa en profundidad además de la guardia: en la config **del worktree** (no la del usuario)
 * - `remote.pushDefault` apunta a un remoto inexistente,
 * - cada remoto tiene `pushurl` inválida,
 * - `url.<inválida>.pushInsteadOf ""` reescribe cualquier destino de push (también URLs explícitas y `--no-verify`),
 * - `core.hooksPath` apunta a hooks del orquestador con un `pre-push` que rechaza.
 */
export async function blockPush(git: GitRunner, worktreePath: string, hooksDir: string): Promise<void> {
  await ensureHooksDir(hooksDir);
  await enableWorktreeConfig(git, worktreePath);
  const remotes = remoteNames((await git(worktreePath, ['remote'])).stdout);
  // Se escribe `config.worktree` de una vez (en Windows cada git.exe cuesta ~65 ms); git lo lee igual
  // que si se usara `git config --worktree` clave por clave.
  const raw = (await git(worktreePath, ['rev-parse', '--git-path', 'config.worktree'])).stdout.trim();
  const file = isAbsolute(raw) ? raw : resolve(worktreePath, raw);
  const block = [
    '# orquestador: push bloqueado en este worktree',
    '[remote]',
    `\tpushDefault = ${quote(BLOCKED_REMOTE)}`,
    ...remotes.flatMap((r) => [`[remote ${quote(r)}]`, `\tpushurl = ${quote(BLOCKED_PUSH_URL)}`]),
    `[url ${quote(BLOCKED_PUSH_URL)}]`,
    '\tpushInsteadOf = ""',
    '[core]',
    `\thooksPath = ${quote(hooksDir.replace(/\\/g, '/'))}`,
    '',
  ].join('\n');
  const current = existsSync(file) ? await readFile(file, 'utf8') : '';
  await writeFile(file, current === '' || current.endsWith('\n') ? current + block : `${current}\n${block}`, 'utf8');
}

/**
 * El mismo bloqueo, por entorno del proceso del agente y sin escribir nada en la config del usuario (modo local: no
 * hay worktree ni `config.worktree`). Va en `GIT_CONFIG_PARAMETERS`, la variable con la que `git -c` pasa la config a
 * sus subprocesos: el filtro `*KEY*` de Codex quitaría `GIT_CONFIG_KEY_<n>` y rompería todo git. Sin `core.hooksPath`:
 * en la carpeta del usuario desactivaría sus hooks, así que no hay `pre-push` que frene un `pushurl` propio del usuario:
 * `pushurl` es una lista (se empuja a todas) y `pushInsteadOf` no la reescribe, por eso cada remoto la vacía (`''`)
 * antes de poner la bloqueada. Si la carpeta no es git, igual vale: `pushInsteadOf ""` también reescribe los remotos
 * que el agente agregue después.
 */
export async function pushBlockEnv(git: GitRunner, folder: string): Promise<Record<string, string>> {
  let remotes: string[] = [];
  try {
    const listed = await git(folder, ['remote'], { check: false });
    if (listed.code === 0) remotes = remoteNames(listed.stdout);
  } catch {
    // Sin git o sin repo: queda el bloqueo general (`pushDefault` y `pushInsteadOf`).
  }
  const pairs: [string, string][] = [
    ['remote.pushDefault', BLOCKED_REMOTE],
    ...remotes.flatMap((r): [string, string][] => [[`remote.${r}.pushurl`, ''], [`remote.${r}.pushurl`, BLOCKED_PUSH_URL]]),
    [`url.${BLOCKED_PUSH_URL}.pushInsteadOf`, ''],
  ];
  return { GIT_CONFIG_PARAMETERS: pairs.map(([key, value]) => `${shellQuote(key)}=${shellQuote(value)}`).join(' ') };
}

function remoteNames(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Comillas de `GIT_CONFIG_PARAMETERS` (las de `sq_quote` de git). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''").replace(/!/g, "'\\!'")}'`;
}

/** Comillas de la sintaxis de config de git (subsecciones y valores). */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
