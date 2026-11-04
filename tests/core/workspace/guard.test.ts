import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assertSafeGitArgs, GitGuardError, isInside } from '../../../src/core/workspace/index.ts';
import type { GitGuardContext } from '../../../src/core/workspace/index.ts';

const user = resolve(tmpdir(), 'copia-usuario');
const roots = resolve(tmpdir(), 'worktrees');
const wt = join(roots, 'tarea-1');
const ctxUser: GitGuardContext = { cwd: user, protectedPaths: [user], managedRoots: [roots] };
const ctxWt: GitGuardContext = { cwd: wt, protectedPaths: [user], managedRoots: [roots] };

function denied(args: string[], ctx: GitGuardContext = ctxWt): void {
  expect(() => assertSafeGitArgs(args, ctx), args.join(' ')).toThrow(GitGuardError);
}
function allowed(args: string[], ctx: GitGuardContext = ctxWt): void {
  expect(() => assertSafeGitArgs(args, ctx), args.join(' ')).not.toThrow();
}

describe('assertSafeGitArgs (lista blanca)', () => {
  it('permite exactamente las formas que usa el módulo', () => {
    allowed(['worktree', 'add', '--relative-paths', wt, '-b', 'orq/t', 'orq/integracion'], ctxUser);
    allowed(['worktree', 'add', '--relative-paths', wt, 'orq/t'], ctxUser);
    allowed(['worktree', 'remove', wt], ctxUser);
    allowed(['worktree', 'prune'], ctxUser);
    allowed(['worktree', 'list', '--porcelain'], ctxUser);
    allowed(['branch', 'orq/integracion', 'main'], ctxUser);
    allowed(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], ctxUser);
    allowed(['rev-parse', '--git-path', 'config.worktree']);
    allowed(['status', '--porcelain', '--untracked-files=all'], ctxUser);
    allowed(['check-ignore', '--no-index', '-z', '--', 'node_modules', '-raro']);
    allowed(['config', '--local', '--get', 'extensions.worktreeConfig']);
    allowed(['config', '--local', 'extensions.worktreeConfig', 'true']);
    allowed(['remote']);
    allowed(['merge', '--no-ff', '--no-commit', '--', 'orq/x']);
    allowed(['merge', '--abort']);
    allowed(['commit', '--no-edit', '-m', '-mensaje que empieza por guion']);
    allowed(['diff', '--name-only', '--diff-filter=U', '-z']);
    allowed(['--no-pager', 'status', '--porcelain']);
  });

  it('niega push siempre, con cualquier opción global o -c (hallazgo 1 de agy)', () => {
    denied(['push']);
    denied(['push', 'origin', 'main']);
    denied(['-c', 'url.x.pushInsteadOf=x', '-c', 'core.hooksPath=', 'push', '--no-verify', 'x', 'orq/t']);
    denied(['--no-pager', 'push'], ctxUser);
  });

  it('niega toda opción global que cambie config o destino (hallazgo 2: include.path)', () => {
    for (const g of [['-c', 'include.path=C:/x.cfg'], ['-c', 'alias.rh=reset --hard'], ['--config-env', 'include.path=V'], ['--config-env=a.b=V'],
      ['-C', user], ['--git-dir=.git'], ['--git-dir', '.git'], ['--work-tree', user], ['--exec-path=C:/x'], ['--namespace=x'], ['--bare'], ['--']]) {
      denied([...g, 'status']);
    }
    denied(['-c', 'include.path=C:/x.cfg', 'rh']);
  });

  it('niega variables GIT_* del llamador (hallazgo 5: GIT_DIR/GIT_WORK_TREE)', () => {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'git_dir']) {
      denied(['status', '--porcelain'], { ...ctxWt, env: { [name]: user } });
    }
    allowed(['status', '--porcelain'], { ...ctxWt, env: { LANG: 'C' } });
  });

  it('niega todo lo que no está en la lista blanca (hallazgos 3, 4 y 5)', () => {
    for (const args of [
      ['rebase', 'main'], ['reset', '--hard'], ['reset', '--soft', 'HEAD~1'], ['filter-branch'], ['filter-repo'],
      ['clean', '-fdx'], ['clean', '--dry-run', '--no-dry-run', '-f', '-d', '-x'], ['clean', '-n'],
      ['branch', '-m', 'orq/integracion', 'orq/borrada'], ['branch', '--move', 'a', 'b'], ['branch', '-d', 'x'], ['branch', '-D', 'x'],
      ['branch', '--delete', 'x'], ['branch', '-f', 'main', 'HEAD'], ['branch', '-M', 'x'], ['branch', 'solo-un-argumento'],
      ['update-ref', 'refs/heads/orq/integracion', '0'.repeat(40)], ['update-ref', '-d', 'refs/heads/x'],
      ['read-tree', '-u', '--reset', 'HEAD~1'], ['checkout-index', '-f', '-a'], ['apply', 'x.patch'], ['update-index', '--assume-unchanged', 'a'],
      ['checkout', 'x'], ['switch', 'x'], ['restore', '.'], ['stash'], ['pull'], ['cherry-pick', 'x'], ['am'], ['gc', '--prune=now'],
      ['config', '--worktree', '--remove-section', 'url.x'], ['config', 'core.hooksPath', ''], ['config', '--local', '--get', 'user.name', 'x'],
      ['worktree', 'remove', '--force', wt], ['worktree', 'remove', '-f', wt], ['worktree', 'move', wt, 'x'], ['worktree', 'lock', wt],
      ['merge', 'orq/x', 'orq/y'], ['merge', '-s', 'ours', 'orq/x'], ['merge', '--strategy=ours', 'orq/x'], ['merge', '--abort', 'x'],
      ['commit', '--amend', '-m', 'x'], ['commit', '-am', 'x'], ['status', '--porcelain', '--untracked-files'],
      ['rh'], [],
    ]) denied(args);
  });

  it('niega merge y commit en la copia del usuario y en sus subcarpetas', () => {
    denied(['merge', '--no-ff', '--no-commit', '--', 'orq/x'], ctxUser);
    denied(['merge', '--abort'], { ...ctxUser, cwd: join(user, 'src') });
    denied(['commit', '--no-edit', '-m', 'x'], ctxUser);
    const inner = join(user, '.worktrees', 'integ');
    denied(['merge', '--abort'], { cwd: inner, protectedPaths: [user] });
    allowed(['merge', '--abort'], { cwd: inner, protectedPaths: [user], allowedPaths: [join(user, '.worktrees')] });
  });

  it('worktree remove solo dentro de las raíces del orquestador, nunca la raíz misma', () => {
    denied(['worktree', 'remove', user], ctxUser);
    denied(['worktree', 'remove', join(tmpdir(), 'otro-worktree-del-usuario')], ctxUser);
    denied(['worktree', 'remove', roots], ctxUser);
    allowed(['worktree', 'remove', join(roots, '_integracion')], ctxUser);
  });

  it('niega argumentos con NUL', () => {
    denied(['status', '--porcelain', '\0']);
  });
});

describe('isInside', () => {
  it('compara rutas sin distinguir mayúsculas en Windows', () => {
    expect(isInside('C:\\Dev\\Repo\\src', 'c:\\dev\\repo', 'win32')).toBe(process.platform === 'win32');
    expect(isInside(join(user, 'a'), user)).toBe(true);
    expect(isInside(`${user}-otro`, user)).toBe(false);
  });
});

describe('assertSafeGitArgs: paso de commit de la flota (A0)', () => {
  it('permite en un worktree de tarea las formas del commit de la flota', () => {
    allowed(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    allowed(['diff', '--name-only', '-z', 'orq/integracion...HEAD']);
    allowed(['add', '-A', '--', '.', ':(exclude).orq']);
    allowed(['commit', '-q', '-m', 'orq: trabajo de la tarea']);
    allowed(['ls-files', '--', '.orq']);
  });
  it('niega add y commit en la copia del usuario, y opciones fuera de la lista', () => {
    denied(['add', '-A', '--', '.'], ctxUser);
    denied(['commit', '-q', '-m', 'x'], ctxUser);
    denied(['add', '-f', '--', '.']);
    denied(['add', '--chmod=+x', '--', 'a']);
    denied(['ls-files', '--others']);
  });
});

describe('assertSafeGitArgs: variables de entorno (A0)', () => {
  it('permite solo la identidad del commit entre las GIT_*', () => {
    allowed(['commit', '-q', '-m', 'x'], { ...ctxWt, env: { GIT_AUTHOR_NAME: 'orquestador', GIT_COMMITTER_EMAIL: 'o@local' } });
    denied(['commit', '-q', '-m', 'x'], { ...ctxWt, env: { GIT_DIR: 'C:/otro' } });
    denied(['status', '--porcelain'], { ...ctxWt, env: { GIT_CONFIG_PARAMETERS: "'remote.origin.pushurl'='x'" } });
  });
});

