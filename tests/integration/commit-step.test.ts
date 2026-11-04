import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommittingWorkspaces, FLEET_IDENTITY, OwnedPathsError, outsideOwnedPaths, parsePorcelainZ } from '../../src/core/app/commit-step.ts';
import { WorktreeManager } from '../../src/core/workspace/index.ts';
import { taskBriefSchema, type TaskBrief, type Workspace } from '../../src/shared/index.ts';
import { cleanupDirs, tempDir } from './helpers.ts';

const managers: { ws: CommittingWorkspaces; created: Workspace[] }[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) for (const w of m.created) await m.ws.remove(w).catch(() => undefined);
  await cleanupDirs();
});

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=Usuario', '-c', 'user.email=usuario@local', ...args], { cwd, encoding: 'utf8' });

function task(id: string, ownedPaths: string[]): TaskBrief {
  return taskBriefSchema.parse({ id, projectId: 'demo', title: `Tarea ${id}`, objective: 'x', ownedPaths, dependsOn: [], acceptance: ['y'], difficulty: 'low' });
}

async function setup(opts: { ignoreOrq?: boolean } = {}) {
  const root = await tempDir('orq-commit-');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"demo","type":"module"}\n');
  if (opts.ignoreOrq) {
    writeFileSync(join(repo, '.gitignore'), '.orq/\nnode_modules/\n');
    writeFileSync(join(repo, 'src', 'viejo.mjs'), 'export const v = 1;\n');
  }
  writeFileSync(join(repo, 'src', 'a.mjs'), 'export const a = 1;\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'inicio']]) expect(git(repo, ...args).status).toBe(0);
  const manager = new WorktreeManager({ projects: [{ id: 'demo', repoPath: repo, worktreesRoot: join(root, 'wt') }], removeRetryDelayMs: 200 });
  const ws = new CommittingWorkspaces({ inner: manager, integrationBranch: (id) => manager.project(id).integrationBranch });
  const entry = { ws, created: [] as Workspace[] };
  managers.push(entry);
  const create = async (t: TaskBrief) => {
    const w = await ws.create('demo', t);
    entry.created.push(w);
    mkdirSync(join(w.path, '.orq'), { recursive: true });
    writeFileSync(join(w.path, '.orq', 'BRIEF.md'), '# encargo\n');
    return w;
  };
  const head = (cwd: string, ref = 'HEAD') => git(cwd, 'rev-parse', ref).stdout.trim();
  return { repo, ws, create, head, mainBefore: head(repo, 'main') };
}

describe('paso de commit de la flota', () => {
  it('parsePorcelainZ y outsideOwnedPaths', () => {
    expect(parsePorcelainZ(' M src/a.mjs\0?? .orq/BRIEF.md\0R  src/nuevo.mjs\0src/viejo.mjs\0 D README.md\0')).toEqual([
      'src/a.mjs', '.orq/BRIEF.md', 'src/nuevo.mjs', 'src/viejo.mjs', 'README.md',
    ]);
    expect(outsideOwnedPaths(['src/a.mjs', '.orq/BRIEF.md', 'src\\x\\y.ts', 'package.json'], ['src/a.mjs', 'src/x/**'])).toEqual(['package.json']);
  });

  it('confirma el trabajo del agente en la rama de la tarea (sin .orq) y lo integra; la copia del usuario no cambia', async () => {
    const { repo, ws, create, head, mainBefore } = await setup();
    const w = await create(task('tarea-a', ['src/a.mjs', 'test/a.test.mjs']));
    writeFileSync(join(w.path, 'src', 'a.mjs'), 'export const a = 2;\n');
    mkdirSync(join(w.path, 'test'));
    writeFileSync(join(w.path, 'test', 'a.test.mjs'), 'import "node:test";\n');

    const summary = await ws.reviewSummary(w);
    expect(summary).toMatch(/src\/a\.mjs/);
    expect(summary).toMatch(/tarea-a: Tarea tarea-a/);
    expect(git(w.path, 'log', '-1', '--format=%an <%ae>').stdout.trim()).toBe(`${FLEET_IDENTITY.name} <${FLEET_IDENTITY.email}>`);
    expect(git(w.path, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort()).toEqual(['src/a.mjs', 'test/a.test.mjs']);

    const result = await ws.integrate('demo', w);
    expect(result).toMatchObject({ ok: true });
    expect(git(repo, 'show', 'orq/integracion:src/a.mjs').stdout).toBe('export const a = 2;\n');
    await ws.remove(w);
    expect(existsSync(w.path)).toBe(false);
    expect(head(repo, 'main')).toBe(mainBefore);
    expect(git(repo, 'status', '--porcelain').stdout).toBe('');
    expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('main');
  });

  it('con .orq en .gitignore (como el repo del orquestador) confirma altas, cambios, borrados y renombres', async () => {
    const { repo, ws, create } = await setup({ ignoreOrq: true });
    const w = await create(task('tarea-ign', ['src/**']));
    writeFileSync(join(w.path, 'src', 'a.mjs'), 'export const a = 3;\n');
    writeFileSync(join(w.path, 'src', 'b.mjs'), 'export const b = 1;\n');
    expect(git(w.path, 'mv', 'src/viejo.mjs', 'src/nuevo.mjs').status).toBe(0);
    writeFileSync(join(w.path, '.orq', 'PLAN-TAREA.md'), '- [x] paso\n');

    const summary = await ws.reviewSummary(w);
    expect(summary).toMatch(/src\/b\.mjs/);
    expect(git(w.path, 'status', '--porcelain').stdout).toBe('');
    const files = git(w.path, 'show', '--no-renames', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort();
    expect(files).toEqual(['src/a.mjs', 'src/b.mjs', 'src/nuevo.mjs', 'src/viejo.mjs']);
    expect((await ws.integrate('demo', w)).ok).toBe(true);
    expect(git(repo, 'show', 'orq/integracion:src/b.mjs').stdout).toBe('export const b = 1;\n');
    expect(git(repo, 'cat-file', '-e', 'orq/integracion:src/viejo.mjs').status).not.toBe(0);
  });

  it('archivos fuera de ownedPaths: no confirma, avisa al revisor e integrate falla con un error claro', async () => {
    const { ws, create, head } = await setup();
    const w = await create(task('tarea-b', ['src/b.mjs']));
    const before = head(w.path);
    writeFileSync(join(w.path, 'src', 'b.mjs'), 'export const b = 1;\n');
    writeFileSync(join(w.path, 'package.json'), '{"name":"cambiado"}\n');
    expect(await ws.reviewSummary(w)).toMatch(/^ATENCIÓN: La tarea tarea-b cambió archivos fuera de sus rutas propias \(ownedPaths\): package\.json/);
    await expect(ws.integrate('demo', w)).rejects.toBeInstanceOf(OwnedPathsError);
    expect(head(w.path)).toBe(before);
    // Deshecho el cambio ajeno, se confirma e integra.
    expect(git(w.path, 'checkout', '--', 'package.json').status).toBe(0);
    expect(await ws.integrate('demo', w)).toMatchObject({ ok: true });
  });

  it('también revisa lo que el agente confirmó por su cuenta', async () => {
    const { ws, create } = await setup();
    const w = await create(task('tarea-c', ['src/c.mjs']));
    writeFileSync(join(w.path, 'README.md'), '# ajeno\n');
    expect(git(w.path, 'add', 'README.md').status).toBe(0);
    expect(git(w.path, 'commit', '-q', '-m', 'commit del agente').status).toBe(0);
    await expect(ws.integrate('demo', w)).rejects.toThrow(/fuera de sus rutas propias \(ownedPaths\): README\.md/);
  });
});
