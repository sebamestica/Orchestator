import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommittingWorkspaces } from '../../src/core/app/commit-step.ts';
import { ProjectWorktrees } from '../../src/core/app/workspaces.ts';
import { taskBriefSchema, type TaskBrief, type Workspace } from '../../src/shared/index.ts';
import { cleanupDirs, tempDir } from './helpers.ts';

// Repos git reales: con la flota en paralelo el equipo va cargado.
vi.setConfig({ testTimeout: 120_000 });

afterEach(async () => {
  await cleanupDirs();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/** Como `python -m pytest` en un repo que no ignora `__pycache__/`. */
const PYC_GATE = { command: process.execPath, args: ['-e', "const fs=require('fs');fs.mkdirSync('tests/__pycache__',{recursive:true});fs.writeFileSync('tests/__pycache__/a.pyc','x')"] };

function task(id: string, ownedPaths: string[]): TaskBrief {
  return taskBriefSchema.parse({ id, projectId: 'demo', title: `Tarea ${id}`, objective: 'x', ownedPaths, dependsOn: [], acceptance: ['y'], difficulty: 'low' });
}

async function setup(gate: unknown[] = [PYC_GATE]) {
  const base = realpathSync.native(await tempDir('orq-gate-restos-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'tests', 'test_x.py'), 'def test_x(): pass\n');
  git(repo, 'init', '-q', '--template=', '-b', 'main');
  for (const [k, v] of [['user.name', 'Usuario Prueba'], ['user.email', 'usuario@prueba.local'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']] as const) git(repo, 'config', k, v);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'inicio');
  const pw = new ProjectWorktrees({ projects: [{ id: 'demo', repoPath: repo, worktreesRoot: join(base, 'wt'), gate }] });
  const ws = new CommittingWorkspaces({ inner: pw, integrationBranch: (id, w) => pw.projectOf(id, w).integrationBranch });
  /** La ronda de la flota hasta antes de revisar: el autor escribe, se confirma (resumen del diff) y corre el gate. */
  const round = async (t: TaskBrief): Promise<{ w: Workspace; gate: { ok: boolean; summary: string } | undefined }> => {
    const w = await ws.create('demo', t);
    mkdirSync(join(w.path, '.orq'), { recursive: true });
    writeFileSync(join(w.path, '.orq', 'BRIEF.md'), '# encargo\n');
    writeFileSync(join(w.path, 'src', 'a.ts'), 'export const a = 2;\n');
    await ws.reviewSummary(w);
    return { w, gate: await ws.verify(w, t) };
  };
  const pending = (w: Workspace) => git(w.path, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l && !l.includes('.orq/'));
  return { repo, ws, round, pending };
}

describe('restos del gate previo a la revisión en el worktree de la tarea', () => {
  it('fuera de las rutas propias: se borran, la tarea se integra y nada entra en las ramas', async () => {
    const { repo, ws, round, pending } = await setup();
    const { w, gate } = await round(task('restos-a', ['src/a.ts']));
    expect(gate?.ok).toBe(true);
    expect(pending(w)).toEqual([]);
    expect(await ws.integrate('demo', w)).toMatchObject({ ok: true });
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'orq/restos-a')).not.toMatch(/__pycache__/);
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'orq/integracion')).not.toMatch(/__pycache__/);
    expect(git(repo, 'show', 'orq/integracion:src/a.ts')).toBe('export const a = 2;\n');
  });

  it('dentro de las rutas propias: no se confirman sin revisión', async () => {
    const { repo, ws, round, pending } = await setup();
    const { w, gate } = await round(task('restos-b', ['src/a.ts', 'tests/**']));
    expect(gate?.ok).toBe(true);
    expect(pending(w)).toEqual([]);
    expect(await ws.integrate('demo', w)).toMatchObject({ ok: true });
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'orq/restos-b')).not.toMatch(/__pycache__/);
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'orq/integracion')).not.toMatch(/__pycache__/);
  });

  it('un gate que modifica archivos versionados falla con el motivo (vuelve al autor) y conserva lo que ya había', async () => {
    const touch = { command: process.execPath, args: ['-e', "require('fs').appendFileSync('tests/test_x.py','# formateado\\n')"] };
    const { round } = await setup([touch]);
    const { w, gate } = await round(task('restos-c', ['src/a.ts']));
    expect(gate?.ok).toBe(false);
    expect(gate?.summary).toMatch(/el gate modificó archivos versionados: tests\/test_x\.py/);
    expect(git(w.path, 'status', '--porcelain', '--untracked-files=all')).toMatch(/\?\? \.orq\//);
  });

  it('integrate no lanza si aparecen archivos fuera de las rutas propias: devuelve el motivo', async () => {
    const { ws, round } = await setup([{ command: process.execPath, args: ['-e', 'process.exit(0)'] }]);
    const { w } = await round(task('restos-d', ['src/a.ts']));
    writeFileSync(join(w.path, 'fuera.txt'), 'x\n');
    const res = await ws.integrate('demo', w);
    expect(res).toMatchObject({ ok: false, conflicts: [] });
    expect(res.gateSummary).toMatch(/^no ejecutado: La tarea restos-d cambió archivos fuera de sus rutas propias \(ownedPaths\): fuera\.txt/);
  });
});
