import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitTaskWork, CommittingWorkspaces, GitIdentityError, isMissingIdentity, OwnedPathsError, outsideOwnedPaths, parsePorcelainZ, SecretInWorkError } from '../../src/core/app/commit-step.ts';
import { createGitRunner, WorktreeManager } from '../../src/core/workspace/index.ts';
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

async function setup(opts: { ignoreOrq?: boolean; secrets?: string[] } = {}) {
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
  // Identidad del «usuario» en la config del repositorio (la heredan los worktrees): la flota confirma con ella.
  for (const args of [['config', 'user.name', 'Usuario Prueba'], ['config', 'user.email', 'usuario@prueba.local']]) expect(git(repo, ...args).status).toBe(0);
  const manager = new WorktreeManager({ projects: [{ id: 'demo', repoPath: repo, worktreesRoot: join(root, 'wt') }], removeRetryDelayMs: 200 });
  const ws = new CommittingWorkspaces({ inner: manager, integrationBranch: (id) => manager.project(id).integrationBranch, ...(opts.secrets ? { secrets: () => opts.secrets ?? [] } : {}) });
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
  return { repo, ws, create, head, mainBefore: head(repo, 'main'), base: () => manager.project('demo').integrationBranch };
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
    // A nombre del usuario (autor y committer), sin trailers de coautoría.
    expect(git(w.path, 'log', '-1', '--format=%an <%ae>|%cn <%ce>').stdout.trim()).toBe('Usuario Prueba <usuario@prueba.local>|Usuario Prueba <usuario@prueba.local>');
    expect(git(w.path, 'log', '-1', '--format=%B').stdout).not.toMatch(/Co-Authored-By|Generated with/i);
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

  it('si el worktree ya no está en la rama de la tarea, no confirma en la rama ajena', async () => {
    const { repo, ws, create, head } = await setup();
    const w = await create(task('tarea-r', ['src/a.mjs']));
    expect(git(w.path, 'checkout', '-q', '-b', 'otra').status).toBe(0);
    const before = head(repo, 'otra');
    writeFileSync(join(w.path, 'src', 'a.mjs'), 'export const a = 3;\n');
    await expect(ws.prepare(w)).rejects.toThrow(/«otra».*orq\/tarea-r/);
    expect(head(repo, 'otra')).toBe(before);
    expect(git(w.path, 'status', '--porcelain').stdout).toMatch(/src\/a\.mjs/);
  });

  it('si el worktree pasó por otra rama (aunque haya vuelto), no confirma: pudo mover una rama compartida', async () => {
    const { repo, ws, create, head } = await setup();
    const w = await create(task('tarea-v', ['src/a.mjs']));
    const before = head(w.path);
    // Mirar un commit suelto no cuenta; pasar por una rama sí.
    expect(git(w.path, 'checkout', '-q', 'HEAD~0').status).toBe(0);
    expect(git(w.path, 'checkout', '-q', 'orq/tarea-v').status).toBe(0);
    expect(git(w.path, 'checkout', '-q', '-b', 'publico').status).toBe(0);
    expect(git(w.path, 'checkout', '-q', 'orq/tarea-v').status).toBe(0);
    writeFileSync(join(w.path, 'src', 'a.mjs'), 'export const a = 4;\n');
    await expect(ws.prepare(w)).rejects.toThrow(/pasó por la rama «publico»/);
    expect(head(w.path)).toBe(before);
    expect(head(repo, 'publico')).toBe(before);
  });

  it('sin identidad git del usuario no confirma nada: error claro, nunca un autor inventado', async () => {
    const { repo, ws, create, head } = await setup();
    const w = await create(task('tarea-sin-autor', ['src/a.mjs']));
    const before = head(w.path);
    writeFileSync(join(w.path, 'src', 'a.mjs'), 'export const a = 9;\n');
    // Nombre vacío en la config del repo: git rechaza el commit aunque haya identidad global.
    expect(git(repo, 'config', 'user.name', '').status).toBe(0);
    await expect(ws.integrate('demo', w)).rejects.toBeInstanceOf(GitIdentityError);
    await expect(ws.reviewSummary(w)).rejects.toThrow(/identidad git/);
    expect(head(w.path)).toBe(before);
  });

  it('isMissingIdentity reconoce los mensajes de git', () => {
    expect(isMissingIdentity('Author identity unknown\n\n*** Please tell me who you are.')).toBe(true);
    expect(isMissingIdentity('fatal: empty ident name (for <x@y>) not allowed')).toBe(true);
    expect(isMissingIdentity('fatal: pathspec did not match')).toBe(false);
  });

  // autoeval-reglas-05: un secreto escrito en disco no entra a la historia a tu nombre.
  const FAKE_ANTHROPIC = `sk-ant-${'a1B2c3D4e5'.repeat(4)}`;
  const OPAQUE = 'valor-opaco-de-la-boveda-77';

  it('clave con prefijo en un archivo propio: lanza SecretInWorkError sin el valor y no confirma', async () => {
    const { ws, create, head, base } = await setup();
    const t = task('tarea-sec', ['src/**', 'test/**']);
    const w = await create(t);
    const before = head(w.path);
    mkdirSync(join(w.path, 'test', 'fixtures'), { recursive: true });
    writeFileSync(join(w.path, 'test', 'fixtures', 'grabacion.json'), `{"x-api-key":"${FAKE_ANTHROPIC}"}\n`);
    writeFileSync(join(w.path, 'src', 'a.mjs'), 'export const a = 5;\n');
    const err = await commitTaskWork(createGitRunner(), w.path, t, base()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretInWorkError);
    expect((err as Error).message).toMatch(/test\/fixtures\/grabacion\.json/);
    expect((err as Error).message).not.toContain(FAKE_ANTHROPIC);
    expect((err as Error).message).not.toMatch(/src\/a\.mjs/);
    expect(head(w.path)).toBe(before);
    const summary = await ws.reviewSummary(w);
    expect(summary).toMatch(/^ATENCIÓN: La tarea tarea-sec escribió lo que parece una clave/);
    expect(summary).not.toContain(FAKE_ANTHROPIC);
    await expect(ws.integrate('demo', w)).rejects.toBeInstanceOf(SecretInWorkError);
    expect(head(w.path)).toBe(before);
  });

  it('valor conocido sin prefijo (de la bóveda) en un archivo ya versionado: no confirma', async () => {
    const { ws, create, head } = await setup({ secrets: [OPAQUE] });
    const w = await create(task('tarea-opaca', ['src/a.mjs']));
    const before = head(w.path);
    writeFileSync(join(w.path, 'src', 'a.mjs'), `export const k = '${OPAQUE}';\n`);
    const summary = await ws.reviewSummary(w);
    expect(summary).toMatch(/^ATENCIÓN: .*src\/a\.mjs/);
    expect(summary).not.toContain(OPAQUE);
    expect(head(w.path)).toBe(before);
  });

  it('secreto en un commit del agente, borrado en el siguiente: sigue en la historia y se niega', async () => {
    const { ws, create } = await setup();
    const w = await create(task('tarea-hist', ['src/**']));
    writeFileSync(join(w.path, 'src', 'k.mjs'), `export const k = '${FAKE_ANTHROPIC}';\n`);
    expect(git(w.path, 'add', 'src/k.mjs').status).toBe(0);
    expect(git(w.path, 'commit', '-q', '-m', 'con clave').status).toBe(0);
    writeFileSync(join(w.path, 'src', 'k.mjs'), 'export const k = process.env.K;\n');
    expect(git(w.path, 'commit', '-q', '-am', 'sin clave').status).toBe(0);
    const summary = await ws.reviewSummary(w);
    expect(summary).toMatch(/^ATENCIÓN: .*src\/k\.mjs.*rehacer la rama/);
    await expect(ws.integrate('demo', w)).rejects.toThrow(/rehacer la rama/);
  });

  it('control: «authorization-service» y palabras con sk- pegado no bloquean', async () => {
    const { ws, create } = await setup();
    const w = await create(task('tarea-ok', ['src/**']));
    writeFileSync(join(w.path, 'src', 'auth.mjs'), "export const authorization = 'authorization-service-client-v2'; // task-scheduler-abcdefghijklmnopqrstuvwxyz\n");
    expect(await ws.reviewSummary(w)).toMatch(/^Cambios de la rama/);
    expect((await ws.integrate('demo', w)).ok).toBe(true);
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
