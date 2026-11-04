import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandSpecSchema, createGitRunner, findOnPath, gitCommonDir, GitError, resolveLaunch, runCommand, type CommandSpec, type LaunchFs } from '../../../src/core/workspace/index.ts';
import { execFileSync } from 'node:child_process';

// Revisión de Codex sobre c13 (H1): el gate y postCreate no pueden resolver su programa en el cwd (el worktree) ni
// dejar que su `env` cambie qué se carga.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const spec = (command: string, args: string[] = [], env: Record<string, string> = {}): CommandSpec => ({ command, args, timeoutMs: 60_000, env });
const win = process.platform === 'win32';
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

describe('resolveLaunch: programa confiable, fuera del worktree', () => {
  it('node es el Node del núcleo; npm y npx, ese Node con su npm-cli.js / npx-cli.js', () => {
    const cwd = temp('orq-launch-');
    expect(resolveLaunch(spec('node', ['-v']), cwd)).toMatchObject({ command: process.execPath, args: ['-v'] });
    for (const name of ['npm', 'npm.cmd', 'NPM.CMD']) {
      const l = resolveLaunch(spec(name, ['run', '-s', 'gate']), cwd);
      expect(l, name).toMatchObject({ command: process.execPath, args: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', '-s', 'gate'] });
    }
    expect(resolveLaunch(spec('npx', ['tsx']), cwd)).toMatchObject({ args: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'), 'tsx'] });
  });

  it('rechaza rutas relativas y ejecutables dentro del cwd o de las carpetas de los agentes (también por junction)', () => {
    const cwd = temp('orq-launch-');
    const outside = temp('orq-launch-fuera-');
    writeFileSync(join(cwd, 'gate.exe'), '');
    expect(resolveLaunch(spec('scripts\\gate.cmd'), cwd)).toMatch(/ruta relativa no permitida/);
    expect(resolveLaunch(spec('.\\gate.exe'), cwd)).toMatch(/ruta relativa no permitida/);
    expect(resolveLaunch(spec(join(cwd, 'gate.exe')), cwd)).toMatch(/dentro de una carpeta de los agentes/);
    const otherWorktree = temp('orq-launch-otro-');
    writeFileSync(join(otherWorktree, 'x.exe'), '');
    expect(resolveLaunch(spec(join(otherWorktree, 'x.exe')), cwd, { untrustedRoots: [otherWorktree] })).toMatch(/dentro de una carpeta de los agentes/);
    // Una ruta «de fuera» que pasa por una junction hacia el worktree tampoco.
    symlinkSync(cwd, join(outside, 'puente'), 'junction');
    expect(resolveLaunch(spec(join(outside, 'puente', 'gate.exe')), cwd)).toMatch(/dentro de una carpeta de los agentes/);
  });

  it('env no puede tocar PATH, ComSpec, NODE_OPTIONS ni npm_config_*: el esquema lo rechaza y el lanzamiento lo ignora', () => {
    for (const key of ['PATH', 'Path', 'PATHEXT', 'ComSpec', 'NODE_OPTIONS', 'NODE_PATH', 'npm_config_script_shell', 'NoDefaultCurrentDirectoryInExePath']) {
      expect(commandSpecSchema.safeParse({ command: 'node', env: { [key]: 'x' } }).success, key).toBe(false);
    }
    expect(commandSpecSchema.safeParse({ command: 'scripts/gate.cmd' }).success).toBe(false);
    expect(commandSpecSchema.safeParse({ command: 'C:\\herramientas\\gate.exe', env: { CI: '1' } }).success).toBe(true);
    const l = resolveLaunch(spec('node', [], { NODE_OPTIONS: '--require ./malo.js', CI: '1' }), temp('orq-launch-'));
    expect(typeof l === 'object' && l.env).toEqual({ CI: '1', ...(win ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) });
  });

  it('findOnPath ignora entradas relativas y las de las carpetas de los agentes', () => {
    const cwd = temp('orq-launch-');
    const good = temp('orq-launch-bin-');
    writeFileSync(join(cwd, 'herramienta.exe'), '');
    writeFileSync(join(good, 'herramienta.exe'), '');
    const sep = win ? ';' : ':';
    const hostEnv = { PATH: ['.', 'relativa\\bin', cwd, good].join(sep) };
    expect(findOnPath('herramienta', { hostEnv }, [cwd])).toBe(join(good, 'herramienta.exe'));
    expect(findOnPath('herramienta', { hostEnv: { PATH: ['.', cwd].join(sep) } }, [cwd])).toBeUndefined();
  });
});

describe('findOnPath y git: fallar cerrado (segunda revisión de Codex)', () => {
  it('descarta un candidato del PATH cuya ruta real cae en un worktree (enlace en una carpeta del PATH) y sigue buscando', () => {
    const sep = win ? ';' : ':';
    const pj = (...p: string[]) => join(...p);
    const toolsDir = pj(tmpdir(), 'herramientas-externas');
    const goodDir = pj(tmpdir(), 'herramientas-buenas');
    const worktree = pj(tmpdir(), 'wt-agente');
    const exe = win ? '.exe' : '';
    // En Windows un enlace simbólico a un archivo pide privilegios: el disco se simula.
    const fs: LaunchFs = {
      isFile: (p) => p === pj(toolsDir, `git${exe}`) || p === pj(goodDir, `git${exe}`),
      realpath: (p) => (p === pj(toolsDir, `git${exe}`) ? pj(worktree, `git${exe}`) : p),
    };
    const hostEnv = { PATH: [toolsDir, goodDir].join(sep) };
    expect(findOnPath('git', { hostEnv, fs }, [worktree])).toBe(pj(goodDir, `git${exe}`));
    expect(findOnPath('git', { hostEnv: { PATH: toolsDir }, fs }, [worktree])).toBeUndefined();
  });

  it('sin un git confiable en el PATH, el ejecutor falla cerrado y no lanza el git del cwd', async () => {
    const cwd = temp('orq-git-');
    if (win) copyFileSync(join(system32, 'hostname.exe'), join(cwd, 'git.exe'));
    const git = createGitRunner({ managedRoots: [cwd], trust: { hostEnv: { PATH: ['.', cwd].join(win ? ';' : ':') } } });
    const err = await git(cwd, ['status', '--porcelain']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toMatch(/no se lanza/);
    expect((err as GitError).result.stdout).toBe('');
  });

  it('gitCommonDir: la copia principal y un worktree enlazado del mismo repo dan la misma carpeta común', () => {
    const base = temp('orq-comun-');
    const repo = join(base, 'repo');
    mkdirSync(repo);
    const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=p', '-c', 'user.email=p@x.invalid', ...a], { cwd, stdio: 'ignore' });
    g(repo, 'init', '-q', '--template=', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'i');
    g(repo, 'worktree', 'add', '-q', '--relative-paths', join(base, 'enlazado'), '-b', 'otra');
    const common = gitCommonDir(repo);
    expect(common).toBe(realpathSync.native(join(repo, '.git')));
    expect(gitCommonDir(join(base, 'enlazado'))).toBe(common);
    expect(gitCommonDir(join(base, 'no-es-repo'))).toBe(join(base, 'no-es-repo'));
  });
});

describe.runIf(win)('señuelos en el worktree (Windows)', () => {
  /** Carpeta de trabajo con señuelos: si alguno se lanzara, su salida diría SENUELO o el nombre del equipo. */
  function decoyWorktree(): string {
    const cwd = temp('orq-senuelos-');
    for (const name of ['npm.cmd', 'node.cmd', 'npx.cmd', 'tsx.cmd']) writeFileSync(join(cwd, name), `@echo SENUELO-${name}\r\n`);
    // Ejecutables señuelo de verdad: `hostname.exe` imprime el nombre del equipo, no lo que se esperaba.
    for (const name of ['node.exe', 'cmd.exe', 'whoami.exe', 'taskkill.exe']) copyFileSync(join(system32, 'hostname.exe'), join(cwd, name));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'senuelos', private: true, scripts: { gate: 'node -e "console.log(\'GATE-REAL \' + process.execPath)"' } }));
    return cwd;
  }

  it('npm.cmd run -s gate lanza el npm del núcleo y el node real dentro del script, no los del cwd', async () => {
    const cwd = decoyWorktree();
    const r = await runCommand(spec('npm.cmd', ['run', '-s', 'gate']), cwd);
    const out = r.tail.join('\n');
    expect(out).not.toMatch(/SENUELO/);
    expect(r.ok, out).toBe(true);
    expect(out).toContain(`GATE-REAL ${process.execPath}`);
  }, 120_000);

  it('node y un programa del PATH (whoami) no se toman del cwd', async () => {
    const cwd = decoyWorktree();
    const host = (await runCommand(spec(join(system32, 'hostname.exe')), cwd)).tail.join('').trim();
    const node = await runCommand(spec('node', ['-e', 'console.log(process.execPath)']), cwd);
    expect(node.tail).toEqual([process.execPath]);
    const who = await runCommand(spec('whoami'), cwd);
    expect(who.ok).toBe(true);
    expect(who.tail.join('')).toContain('\\'); // «equipo\usuario» del whoami real; el señuelo imprimiría el equipo
    expect(who.tail.join('').trim()).not.toBe(host);
  }, 120_000);

  it('un .cmd de fuera del worktree va por el cmd.exe del sistema, no por el del cwd', async () => {
    const cwd = decoyWorktree();
    const tools = temp('orq-herramientas-');
    mkdirSync(join(tools, 'bin'));
    const cmd = join(tools, 'bin', 'gate.cmd');
    writeFileSync(cmd, '@echo CMD-REAL %1\r\n');
    const r = await runCommand(spec(cmd, ['uno']), cwd);
    expect(r.ok).toBe(true);
    expect(r.tail).toEqual(['CMD-REAL uno']);
  }, 120_000);
});
