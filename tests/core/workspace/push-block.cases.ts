import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCKED_PUSH_URL, WorktreeManager } from '../../../src/core/workspace/index.ts';
import { brief, commitFile, makeRepo } from './helpers.ts';
import type { TempRepo } from './helpers.ts';

let t: TempRepo | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** git directo (sin la guardia), como lo lanzaría un agente que se la salta. */
function rawGit(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function setup(): { t: TempRepo; mgr: WorktreeManager; bare: string } {
  t = makeRepo();
  const bare = join(t.base, 'remoto.git');
  t.git(t.base, 'init', '-q', '--bare', bare);
  t.git(t.repo, 'remote', 'add', 'origin', bare);
  const mgr = new WorktreeManager({ projects: [{ id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot, links: ['node_modules'] }] });
  return { t, mgr, bare };
}

function localConfig(t: TempRepo): string[] {
  return t.git(t.repo, 'config', '--list', '--local').split(/\r?\n/).filter(Boolean).sort();
}

describe('bloqueo de push a nivel de git en los worktrees', () => {
  it('git push falla desde el worktree de tarea por cualquier vía, y el remoto no cambia', async () => {
    const { t, mgr, bare } = setup();
    const ws = await mgr.create('demo', brief('tarea-push'));
    commitFile(t, ws.path, 'b.txt', 'nuevo\n');

    const intentos: string[][] = [
      ['push'],
      ['push', 'origin', 'orq/tarea-push'],
      ['push', '--no-verify', 'origin', 'orq/tarea-push'],
      ['push', '--no-verify', bare, 'orq/tarea-push'],
      ['push', '--no-verify', `file://${bare.replace(/\\/g, '/')}`, 'HEAD:refs/heads/robada'],
    ];
    for (const args of intentos) {
      const r = rawGit(ws.path, args);
      expect(r.code, `git ${args.join(' ')}: ${r.out}`).not.toBe(0);
    }
    expect(rawGit(bare, ['for-each-ref']).out.trim()).toBe('');

    // El hook pre-push del orquestador rechaza por sí solo.
    const hook = rawGit(ws.path, ['hook', 'run', 'pre-push']);
    expect(hook.code).not.toBe(0);
    expect(hook.out).toMatch(/push bloqueado/);
    // La config de bloqueo vive en el worktree.
    expect(t.git(ws.path, 'config', '--worktree', '--get', 'remote.origin.pushurl').trim()).toBe(BLOCKED_PUSH_URL);
    expect(t.git(ws.path, 'config', '--get', 'remote.pushDefault').trim()).toBe('orquestador-bloqueado');
    expect(t.git(ws.path, 'config', '--get', 'core.hooksPath').trim()).toBe(join(t.worktreesRoot, '_hooks').replace(/\\/g, '/'));
    expect(t.git(ws.path, 'config', '--get-regexp', 'pushinsteadof').trim()).toBe(`url.${BLOCKED_PUSH_URL}.pushinsteadof`);
  });

  it('la copia principal del usuario conserva su config y puede hacer push', async () => {
    const { t, mgr, bare } = setup();
    const before = localConfig(t);
    const ws = await mgr.create('demo', brief('tarea-cfg'));
    await mgr.integrate('demo', ws);
    const after = localConfig(t);
    // Únicas diferencias: extensiones de formato del repo. `relativeworktrees` (y formato 1) las pone el propio
    // `git worktree add --relative-paths`; `worktreeconfig` habilita la config por worktree. Nada de push ni hooks.
    const isFormat = (l: string) => l.startsWith('extensions.') || l.startsWith('core.repositoryformatversion=');
    expect(after.filter((l) => !before.includes(l) && !l.startsWith('core.repositoryformatversion='))).toEqual([
      'extensions.relativeworktrees=true',
      'extensions.worktreeconfig=true',
    ]);
    expect(after.filter((l) => !isFormat(l))).toEqual(before.filter((l) => !isFormat(l)));
    for (const key of ['core.hooksPath', 'remote.pushDefault', 'remote.origin.pushurl']) {
      expect(rawGit(t.repo, ['config', '--get', key]).code, key).not.toBe(0);
    }
    // El push del usuario sigue funcionando (prueba que el bloqueo no le afecta).
    const push = rawGit(t.repo, ['push', 'origin', 'main']);
    expect(push.code, push.out).toBe(0);
    expect(rawGit(bare, ['for-each-ref', '--format=%(refname)']).out.trim()).toBe('refs/heads/main');
  });

  it('el worktree de integración también tiene el push bloqueado', async () => {
    const { t, mgr, bare } = setup();
    const ws = await mgr.create('demo', brief('tarea-int'));
    commitFile(t, ws.path, 'c.txt', 'c\n');
    const res = await mgr.integrate('demo', ws);
    expect(res.ok).toBe(true);
    const integ = join(t.worktreesRoot, '_integracion');
    const r = rawGit(integ, ['push', '--no-verify', bare, 'orq/integracion']);
    expect(r.code, r.out).not.toBe(0);
    expect(rawGit(bare, ['for-each-ref']).out.trim()).toBe('');
  });
});
