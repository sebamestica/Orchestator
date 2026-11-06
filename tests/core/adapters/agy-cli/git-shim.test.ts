/**
 * autoeval-reglas-04: el `git` de Berland para agy corta las vías de push que el bloqueo del worktree no cubre
 * (`-c pushurl=`, `pushInsteadOf`, `-C <copia principal>`) y deja trabajar a git en el worktree. El control (el git real
 * sí publica por esas vías) está en `tests/core/workspace/push-block.cases.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findRealGit, gitShimCmd, gitShimEnv, pathValue, withGitShim } from '../../../../src/core/adapters/agy-cli/git-shim.ts';
import { WorktreeManager } from '../../../../src/core/workspace/index.ts';
import { brief, commitFile, makeRepo } from '../../workspace/helpers.ts';
import type { TempRepo } from '../../workspace/helpers.ts';

vi.setConfig({ testTimeout: 120_000 });

let t: TempRepo | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Lanza el `git.cmd` de Berland como lo haría el shell de agy (`env`, sobre el del proceso). */
function shimGit(gitCmd: string, cwd: string, args: string[], env?: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('cmd.exe', ['/d', '/c', gitCmd, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('gitShimCmd', () => {
  it('llama a Node con el script, el git real y el worktree, y escapa % para cmd', () => {
    const cmd = gitShimCmd({ node: 'C:\\n\\node.exe', script: 'C:\\b\\git-shim.ts', realGit: 'C:\\Program Files\\Git\\cmd\\git.exe', worktree: 'C:\\wt\\100%' });
    expect(cmd).toBe('@"C:\\n\\node.exe" "C:\\b\\git-shim.ts" "C:\\Program Files\\Git\\cmd\\git.exe" "C:\\wt\\100%%" %*\r\n');
  });

  it('findRealGit ignora carpetas relativas del PATH', () => {
    expect(findRealGit(['.', 'relativa'].join(delimiter))).toBeUndefined();
  });

  it('gitShimEnv quita las GIT_* heredadas salvo la autoría', () => {
    const env = gitShimEnv({
      PATH: 'C:\\Windows',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'alias.x',
      GIT_CONFIG_VALUE_0: 'push',
      git_config_parameters: "'core.x=1'",
      GIT_DIR: 'C:\\otro\\.git',
      GIT_AUTHOR_NAME: 'Autora',
      GIT_COMMITTER_EMAIL: 'c@e.invalid',
    });
    expect(env).toEqual({ PATH: 'C:\\Windows', GIT_AUTHOR_NAME: 'Autora', GIT_COMMITTER_EMAIL: 'c@e.invalid' });
  });
});

describe.skipIf(process.platform !== 'win32')('git de Berland para agy (repo real)', () => {
  it('niega las vías de push, -C fuera del worktree, config y remote; status y commit funcionan', async () => {
    t = makeRepo();
    const bare = join(t.base, 'remoto.git');
    t.git(t.base, 'init', '-q', '--bare', bare);
    t.git(t.repo, 'remote', 'add', 'origin', bare);
    const mgr = new WorktreeManager({ projects: [{ id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot, links: ['node_modules'] }] });
    const ws = await mgr.create('demo', brief('tarea-shim'));
    commitFile(t, ws.path, 'b.txt', 'nuevo\n');

    const env = await withGitShim(ws.path, {});
    const shimDir = join(ws.path, '.orq', 'bin');
    expect(pathValue(env)?.split(delimiter)[0]).toBe(shimDir);
    const gitCmd = join(shimDir, 'git.cmd');
    expect(readFileSync(gitCmd, 'utf8')).toContain('git.exe');

    const refsBefore = t.git(t.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    const intentos: string[][] = [
      ['push', 'origin', 'HEAD:refs/heads/a'],
      ['-c', 'remote.origin.pushurl=', '-c', `remote.origin.pushurl=${bare}`, 'push', '--no-verify', 'origin', 'HEAD:refs/heads/b'],
      ['-c', `url.${bare}.pushInsteadOf=${bare}`, 'push', '--no-verify', bare, 'HEAD:refs/heads/c'],
      ['-C', t.repo, 'push', 'origin', 'orq/tarea-shim:refs/heads/d'],
      ['send-pack', bare, 'HEAD:refs/heads/e'],
      ['config', '--worktree', '--unset-all', 'remote.origin.pushurl'],
      ['remote', 'set-url', '--push', 'origin', bare],
      // La regla de los workers (autoeval-reglas-02): tampoco vacía el stash ni mueve ramas de otro worktree.
      ['stash', 'clear'],
      ['checkout', '--ignore-other-worktrees', '-B', 'main'],
    ];
    for (const args of intentos) {
      const r = shimGit(gitCmd, ws.path, args);
      expect(r.code, `git ${args.join(' ')}: ${r.out}`).not.toBe(0);
      expect(r.out).toMatch(/berland: git bloqueado/);
    }
    expect(t.git(bare, 'for-each-ref').trim()).toBe('');
    expect(t.git(t.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);

    const status = shimGit(gitCmd, ws.path, ['status', '--short']);
    expect(status.code, status.out).toBe(0);
    writeFileSync(join(ws.path, 'c.txt'), 'c\n');
    expect(shimGit(gitCmd, ws.path, ['add', 'c.txt']).code).toBe(0);
    const commit = shimGit(gitCmd, ws.path, ['commit', '-q', '-m', 'con-el-shim']);
    expect(commit.code, commit.out).toBe(0);
    expect(t.git(ws.path, 'log', '-1', '--format=%s').trim()).toBe('con-el-shim');

    // Configuración por entorno (GIT_CONFIG_COUNT/KEY_n/VALUE_n): no llega al git real.
    const injected = (key: string, value: string) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value });
    const alias = shimGit(gitCmd, ws.path, ['publica'], injected('alias.publica', `push --no-verify ${bare} HEAD:refs/heads/f`));
    expect(alias.code, alias.out).not.toBe(0);
    expect(t.git(bare, 'for-each-ref').trim()).toBe('');
    writeFileSync(join(ws.path, 'd.txt'), 'd\n');
    expect(shimGit(gitCmd, ws.path, ['add', 'd.txt']).code).toBe(0);
    const named = shimGit(gitCmd, ws.path, ['commit', '-q', '-m', 'sin-inyectar'], injected('user.name', 'inyectado'));
    expect(named.code, named.out).toBe(0);
    expect(t.git(ws.path, 'log', '-1', '--format=%an').trim()).not.toBe('inyectado');
  });
});
