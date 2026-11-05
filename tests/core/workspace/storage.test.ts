/** Estado de almacenamiento de una carpeta (git de solo lectura por la guardia): repos git reales en carpetas temporales. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitRunner,
  GitError,
  hasGitDir,
  parseRemoteUrls,
  readProjectStorage,
  remoteUrlKey,
  sameRemoteUrl,
  sanitizeRemoteUrl,
  type GitRunner,
} from '../../../src/core/workspace/index.ts';

// Repos git reales: con la flota corriendo en paralelo el equipo va cargado.
vi.setConfig({ testTimeout: 90_000 });

const dirs: string[] = [];
async function temp(prefix = 'orq-storage-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}
const commit = (cwd: string, message = 'inicio') =>
  git(cwd, '-c', 'user.name=Persona Prueba', '-c', 'user.email=persona@example.invalid', 'commit', '-q', '--allow-empty', '-m', message);

describe('sanitizeRemoteUrl', () => {
  it.each([
    ['https://token@github.com/a/b', 'https://github.com/a/b'],
    ['https://usuario:clave@github.com/a/b.git', 'https://github.com/a/b.git'],
    ['https://github.com/a/b?access_token=abc#x', 'https://github.com/a/b'],
    ['git@github.com:a/b.git', 'github.com/a/b'],
    ['github.com:a/b', 'github.com/a/b'],
    ['ssh://git@github.com:22/a/b.git', 'ssh://github.com:22/a/b.git'],
    ['  https://github.com/sebamestica/Orchestator.git\n', 'https://github.com/sebamestica/Orchestator.git'],
    ['C:\\repos\\b', 'C:\\repos\\b'],
    ['/srv/git/b.git', '/srv/git/b.git'],
    ['', ''],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeRemoteUrl(raw)).toBe(expected);
  });

  it('una URL con token de GitHub no lo deja ni sin usuario', () => {
    const out = sanitizeRemoteUrl('https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b');
    expect(out).toBe('https://github.com/a/b');
    expect(out).not.toMatch(/ghp_/);
  });

  it('es idempotente', () => {
    for (const raw of ['https://token@github.com/a/b', 'git@github.com:a/b.git', 'ssh://git@host:22/x']) {
      const once = sanitizeRemoteUrl(raw);
      expect(sanitizeRemoteUrl(once)).toBe(once);
    }
  });
});

describe('sameRemoteUrl', () => {
  it('HTTPS, SSH y SCP del mismo repositorio coinciden, con o sin .git, puerto o mayúsculas', () => {
    expect(remoteUrlKey('https://github.com/a/b.git')).toBe('github.com/a/b');
    expect(sameRemoteUrl('https://github.com/Sebamestica/Orchestator', 'git@github.com:sebamestica/Orchestator.git')).toBe(true);
    expect(sameRemoteUrl('ssh://git@github.com:22/a/b.git', 'https://token@github.com/a/b/')).toBe(true);
    expect(sameRemoteUrl('github.com/a/b', 'https://github.com/a/b')).toBe(true);
  });

  it('repositorios distintos o una URL vacía no coinciden', () => {
    expect(sameRemoteUrl('https://github.com/a/b', 'https://github.com/a/c')).toBe(false);
    expect(sameRemoteUrl('https://github.com/a/b', 'https://gitlab.com/a/b')).toBe(false);
    expect(sameRemoteUrl('', '')).toBe(false);
  });
});

describe('parseRemoteUrls', () => {
  it('lee la url de cada [remote "…"] e ignora las demás secciones y claves', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\turl = no-es-un-remoto',
      '[remote "origin"]',
      '\turl = https://github.com/a/b.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]',
      '\tremote = origin',
      '[remote "Arriba"]',
      '\tURL = git@github.com:otro/b.git ; comentario',
    ].join('\r\n');
    expect(Object.fromEntries(parseRemoteUrls(config))).toEqual({ origin: 'https://github.com/a/b.git', Arriba: 'git@github.com:otro/b.git' });
  });

  it('comillas, escapes, continuación, la forma antigua [remote.x] y la primera url de varias', () => {
    const config = [
      '# comentario',
      '[remote "con \\"comillas\\""] url = "C:/Mis repos/b" # al final',
      '[remote.Viejo]',
      '  url = https://ejemplo.invalid/\\',
      'a/b',
      '[remote "doble"]',
      '  url = https://primero.invalid/x',
      '  url = https://segundo.invalid/x',
      '  pushurl = https://empuje.invalid/x',
      '[remote "sin-url"]',
      '  fetch = +refs/heads/*:refs/remotes/sin-url/*',
    ].join('\n');
    expect(Object.fromEntries(parseRemoteUrls(config))).toEqual({
      'con "comillas"': 'C:/Mis repos/b',
      viejo: 'https://ejemplo.invalid/a/b',
      doble: 'https://primero.invalid/x',
    });
  });
});

describe('readProjectStorage', () => {
  it("'none' si la carpeta no es git", async () => {
    const dir = await temp();
    expect(await hasGitDir(dir)).toBe(false);
    expect(await readProjectStorage(dir)).toEqual({ kind: 'none', branch: null, remote: null, remotes: [] });
  });

  it("'local' en un repositorio git sin remoto (también sin commits)", async () => {
    const dir = await temp();
    git(dir, 'init', '-q', '-b', 'main');
    expect(await readProjectStorage(dir)).toEqual({ kind: 'local', branch: 'main', remote: null, remotes: [] });
    commit(dir);
    git(dir, 'branch', 'trabajo', 'main');
    expect((await readProjectStorage(dir)).branch).toBe('main');
  });

  it("'remote': prefiere origin, con la rama y las URLs saneadas", async () => {
    const dir = await temp();
    git(dir, 'init', '-q', '-b', 'trabajo');
    git(dir, 'remote', 'add', 'arriba', 'git@github.com:otro/b.git');
    git(dir, 'remote', 'add', 'origin', 'https://token@github.com/a/b');
    expect(await readProjectStorage(dir)).toEqual({
      kind: 'remote',
      branch: 'trabajo',
      remote: { name: 'origin', url: 'https://github.com/a/b' },
      remotes: [
        { name: 'arriba', url: 'github.com/otro/b' },
        { name: 'origin', url: 'https://github.com/a/b' },
      ],
    });
  });

  it("'remote' sin origin: el primero, con SSH como host/ruta", async () => {
    const dir = await temp();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'remote', 'add', 'arriba', 'git@github.com:a/b.git');
    expect(await readProjectStorage(dir)).toMatchObject({ kind: 'remote', branch: 'main', remote: { name: 'arriba', url: 'github.com/a/b' } });
  });

  it('desde un worktree lee la config común y la rama del worktree; con HEAD separado, rama null', async () => {
    const base = await temp();
    const repo = join(base, 'repo');
    git(base, 'init', '-q', '-b', 'main', repo);
    commit(repo);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/sebamestica/Orchestator.git');
    const wt = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'orq/tarea', wt);
    expect(await readProjectStorage(wt)).toMatchObject({ kind: 'remote', branch: 'orq/tarea', remote: { name: 'origin', url: 'https://github.com/sebamestica/Orchestator.git' } });
    git(repo, 'checkout', '-q', '--detach');
    expect((await readProjectStorage(repo)).branch).toBeNull();
  });

  it('pasa por la guardia: solo remote y rev-parse (sin config --get ni symbolic-ref), y nada que escriba', async () => {
    const dir = await temp();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/a/b');
    const before = git(dir, 'config', '--list', '--local');
    const seen: string[][] = [];
    const real = createGitRunner();
    const spy: GitRunner = (cwd, args, opts) => {
      seen.push([...args]);
      return real(cwd, args, opts);
    };
    expect(await readProjectStorage(dir, { git: spy })).toMatchObject({ kind: 'remote', remote: { url: 'https://github.com/a/b' } });
    expect(seen.map((a) => a[0])).toEqual(expect.arrayContaining(['remote', 'rev-parse']));
    expect(seen.every((a) => a[0] === 'remote' || a[0] === 'rev-parse')).toBe(true);
    expect(git(dir, 'config', '--list', '--local')).toBe(before);
  });

  it("si git no corre, 'none'", async () => {
    const dir = await temp();
    git(dir, 'init', '-q', '-b', 'main');
    const broken: GitRunner = async (_cwd, args) => {
      throw new GitError('git no está en el PATH', args, { code: null, stdout: '', stderr: '', timedOut: false });
    };
    expect(await readProjectStorage(dir, { git: broken })).toEqual({ kind: 'none', branch: null, remote: null, remotes: [] });
  });
});
