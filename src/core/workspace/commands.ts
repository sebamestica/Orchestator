import { realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { redactSecrets } from '../../shared/index.ts';
import { runJsonl } from '../process/run-jsonl.ts';
import { LOADER_ENV, type CommandSpec } from './config.ts';
import { isInside } from './guard.ts';

export interface CommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Últimas líneas de salida (stdout y stderr), ya redactadas. */
  tail: string[];
}

const TAIL_LINES = 20;

function describe(spec: CommandSpec): string {
  return [spec.command, ...spec.args].join(' ');
}

/** Metacaracteres de cmd.exe (y espacios, que obligarían a comillas que cmd interpreta a su manera). */
const CMD_UNSAFE = /[\s&|<>^%!"()]/;

export interface LaunchTrust {
  /** Carpetas escribibles por los agentes (worktrees). Ningún ejecutable puede salir de ahí; el cwd siempre cuenta. */
  untrustedRoots?: readonly string[];
  /** Node fijado para `node`, `npm` y `npx` (por defecto el que corre el núcleo: `process.execPath`). */
  nodePath?: string;
  /** Entorno del núcleo para buscar en el PATH y encontrar cmd.exe (por defecto `process.env`). */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** Disco (inyectable en pruebas: en Windows crear un enlace simbólico a un archivo pide privilegios). */
  fs?: LaunchFs;
}

export interface LaunchFs {
  isFile(p: string): boolean;
  /** Ruta real; lanza si no existe. */
  realpath(p: string): string;
}

const nodeLaunchFs: LaunchFs = {
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  realpath: (p) => realpathSync.native(p),
};

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function absoluteFor(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) : posix.isAbsolute(p);
}

function realOrSelf(p: string, fs: LaunchFs = nodeLaunchFs): string {
  try {
    return fs.realpath(p);
  } catch {
    return p;
  }
}

/** `p` (o su ruta real) cae en alguna de las carpetas (o en sus rutas reales). */
function insideAny(p: string, roots: readonly string[], platform: NodeJS.Platform, fs: LaunchFs = nodeLaunchFs): boolean {
  const real = realOrSelf(p, fs);
  return roots.some((r) => isInside(p, r, platform) || isInside(real, realOrSelf(r, fs), platform));
}

function isFile(p: string): boolean {
  return nodeLaunchFs.isFile(p);
}

/**
 * Busca `name` en el PATH del núcleo, **nunca** en el cwd (`spawn` sin shell y cmd.exe miran primero el cwd en
 * Windows): solo entradas absolutas y fuera de las carpetas de los agentes. También se descarta un candidato cuya
 * ruta **real** cae en esas carpetas (un enlace en una carpeta del PATH hacia un worktree), y la búsqueda sigue.
 */
export function findOnPath(name: string, trust: LaunchTrust = {}, untrusted: readonly string[] = []): string | undefined {
  const platform = trust.platform ?? process.platform;
  const env = trust.hostEnv ?? process.env;
  const fs = trust.fs ?? nodeLaunchFs;
  const exts = platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(name) ? ['.com', '.exe', '.bat', '.cmd'] : [''];
  for (const raw of (envValue(env, 'PATH') ?? '').split(platform === 'win32' ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !absoluteFor(dir, platform) || insideAny(dir, untrusted, platform, fs)) continue;
    for (const ext of exts) {
      const candidate = (platform === 'win32' ? win32 : posix).join(dir, name + ext);
      if (!fs.isFile(candidate)) continue;
      let real: string;
      try {
        real = fs.realpath(candidate);
      } catch {
        continue;
      }
      if (!absoluteFor(real, platform) || insideAny(real, untrusted, platform, fs)) continue;
      return candidate;
    }
  }
  return undefined;
}

/** cmd.exe del sistema (`%SystemRoot%\System32\cmd.exe`), nunca uno del cwd ni del PATH. */
function systemCmd(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const root = envValue(env, 'SystemRoot') ?? 'C:\\Windows';
  const cmd = win32.join(root, 'System32', 'cmd.exe');
  return isFile(cmd) ? cmd : undefined;
}

/**
 * Resuelve el programa de un comando de `postCreate` o del gate a una ruta absoluta confiable, fuera del worktree:
 * - `node` es el Node del núcleo; `npm` y `npx` son ese Node con su `npm-cli.js`/`npx-cli.js` (sin `npm.cmd`);
 * - otro nombre se busca en el PATH del núcleo (ver `findOnPath`); una ruta absoluta se usa tal cual;
 * - una ruta relativa, o un ejecutable dentro del cwd o de las carpetas de los agentes, se rechaza;
 * - `.cmd`/`.bat` van por el cmd.exe del sistema y solo con argumentos sin espacios ni metacaracteres;
 * - `env` del comando no puede tocar las variables de carga (`LOADER_ENV`), y en Windows se fija
 *   `NoDefaultCurrentDirectoryInExePath=1` para que cmd.exe (y los scripts de npm) no busquen en el cwd.
 * Devuelve el motivo si no se puede lanzar con seguridad.
 */
export function resolveLaunch(spec: CommandSpec, cwd: string, trust: LaunchTrust = {}): Launch | string {
  const platform = trust.platform ?? process.platform;
  const hostEnv = trust.hostEnv ?? process.env;
  const untrusted = [cwd, ...(trust.untrustedRoots ?? [])];
  const node = trust.nodePath ?? process.execPath;
  const name = spec.command;
  let command: string;
  let args = [...spec.args];
  if (!/[\\/]/.test(name)) {
    const key = name.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
    if (key === 'node') {
      command = node;
    } else if (key === 'npm' || key === 'npx') {
      const cli = (platform === 'win32' ? win32 : posix).join((platform === 'win32' ? win32 : posix).dirname(node), 'node_modules', 'npm', 'bin', `${key}-cli.js`);
      if (!isFile(cli)) return `no se encuentra ${key}-cli.js junto al Node del núcleo (${cli})`;
      if (insideAny(cli, untrusted, platform)) return `${cli} está dentro de una carpeta de los agentes: no se lanza`;
      command = node;
      args = [cli, ...args];
    } else {
      const found = findOnPath(name, trust, untrusted);
      if (!found) return `«${name}» no está en el PATH del núcleo (nunca se busca en la carpeta del worktree)`;
      command = found;
    }
  } else if (absoluteFor(name, platform)) {
    command = name;
  } else {
    return `ruta relativa no permitida («${name}»): usa un nombre del PATH (node, npm…) o una ruta absoluta`;
  }
  if (insideAny(command, untrusted, platform)) return `el ejecutable ${command} está dentro de una carpeta de los agentes (worktree): no se lanza`;

  const env: Record<string, string> = Object.fromEntries(Object.entries(spec.env).filter(([k]) => !LOADER_ENV.test(k)));
  if (platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) return { command, args, env };
  // En Windows, Node 24 no lanza `.cmd`/`.bat` sin shell (EINVAL, mitigación de CVE-2024-27980): van por cmd.exe
  // solo si ningún argumento necesita comillas ni lleva metacaracteres, así cmd.exe no puede reinterpretarlos.
  const parts = [command, ...args];
  const bad = parts.find((a) => a === '' || CMD_UNSAFE.test(a));
  if (bad !== undefined) return `un .cmd/.bat solo admite ruta y argumentos sin espacios ni metacaracteres de cmd.exe («${bad}»); usa node con el script .js`;
  const cmd = systemCmd(hostEnv);
  if (!cmd || insideAny(cmd, untrusted, platform)) return 'no se encuentra el cmd.exe del sistema (%SystemRoot%\\System32)';
  return { command: cmd, args: ['/d', '/c', ...parts], env };
}

/** Ejecuta un comando de `postCreate` o del gate, sin shell y con timeout (mata el árbol en Windows). */
export async function runCommand(spec: CommandSpec, cwd: string, signal?: AbortSignal, trust: LaunchTrust = {}): Promise<CommandResult> {
  const started = Date.now();
  const tail: string[] = [];
  let code: number | null = null;
  let timedOut = false;
  const fail = (why: string): CommandResult => ({
    command: describe(spec), ok: false, code: null, timedOut: false, durationMs: Date.now() - started, tail: [...tail, redactSecrets(why)].slice(-TAIL_LINES),
  });
  const target = resolveLaunch(spec, cwd, trust);
  if (typeof target === 'string') return fail(target);
  try {
    for await (const item of runJsonl({ command: target.command, args: target.args, cwd, env: target.env, timeoutMs: spec.timeoutMs, signal })) {
      if (item.kind === 'exit') {
        code = item.code;
        timedOut = item.timedOut;
        continue;
      }
      tail.push(redactSecrets(item.line));
      if (tail.length > TAIL_LINES) tail.shift();
    }
  } catch (err) {
    // spawn lanza de forma síncrona con argumentos inválidos (NUL, EINVAL): es un fallo del comando, no del núcleo.
    return fail(`no se pudo lanzar: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { command: describe(spec), ok: code === 0 && !timedOut, code, timedOut, durationMs: Date.now() - started, tail };
}

/** Corre los comandos en orden y se detiene en el primero que falla. */
export async function runCommands(specs: readonly CommandSpec[], cwd: string, signal?: AbortSignal, trust: LaunchTrust = {}): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const spec of specs) {
    const r = await runCommand(spec, cwd, signal, trust);
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}

/** Resumen breve para `IntegrationResult.gateSummary` (sin claves). */
export function summarizeCommands(results: readonly CommandResult[], total: number): string {
  if (total === 0) return 'gate: sin comandos configurados';
  const lines = results.map((r) => {
    const state = r.ok ? 'ok' : r.timedOut ? 'tiempo agotado' : `falló (código ${String(r.code)})`;
    return `- ${r.command}: ${state} en ${String(r.durationMs)} ms`;
  });
  const failed = results.find((r) => !r.ok);
  const head = failed ? `gate fallido (${String(results.length)}/${String(total)} comandos)` : `gate ok (${String(total)} comandos)`;
  const tail = failed && failed.tail.length > 0 ? ['salida:', ...failed.tail.map((l) => `  ${l}`)] : [];
  return [head, ...lines, ...tail].join('\n');
}
