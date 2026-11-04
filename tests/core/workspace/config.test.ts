import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceProject, WorkspaceConfigError, WorkspaceError, WorktreeManager } from '../../../src/core/workspace/index.ts';

const repoPath = join(tmpdir(), 'repo-config');

describe('configuración de worktrees', () => {
  it('completa los valores por defecto', () => {
    const p = parseWorkspaceProject({ id: 'demo', repoPath });
    expect(p).toMatchObject({ baseBranch: 'main', integrationBranch: 'orq/integracion', links: [], postCreate: [], gate: [] });
    expect(p.worktreesRoot).toBe('C:\\dev\\.worktrees\\demo');
    expect(p.hooksDir).toBe(join('C:\\dev\\.worktrees\\demo', '_hooks'));
  });

  it('valida comandos y rutas de enlaces', () => {
    const p = parseWorkspaceProject({ id: 'demo', repoPath, gate: [{ command: 'node', args: ['-v'] }] });
    expect(p.gate[0]).toEqual({ command: 'node', args: ['-v'], timeoutMs: 600_000, env: {} });
    expect(() => parseWorkspaceProject({ id: 'demo', repoPath, links: ['../fuera'] })).toThrow(WorkspaceConfigError);
    expect(() => parseWorkspaceProject({ id: 'demo', repoPath, links: ['C:\\abs'] })).toThrow(WorkspaceConfigError);
    expect(() => parseWorkspaceProject({ id: 'demo', repoPath, gate: [{ command: '' }] })).toThrow(WorkspaceConfigError);
    expect(() => parseWorkspaceProject({ id: 'demo', repoPath, extra: 1 })).toThrow(WorkspaceConfigError);
  });

  it('rechaza ramas peligrosas o iguales a la base', () => {
    expect(() => parseWorkspaceProject({ id: 'demo', repoPath, integrationBranch: 'main' })).toThrow(/rama base/);
    for (const bad of ['-x', 'a..b', 'a b', 'a/', '/a', 'x.lock']) {
      expect(() => parseWorkspaceProject({ id: 'demo', repoPath, integrationBranch: bad }), bad).toThrow(WorkspaceConfigError);
    }
  });

  it('el gestor rechaza worktreesRoot dentro de la copia del usuario', () => {
    expect(() => new WorktreeManager({ projects: [{ id: 'demo', repoPath, worktreesRoot: join(repoPath, '.wt') }] })).toThrow(WorkspaceError);
  });
});
