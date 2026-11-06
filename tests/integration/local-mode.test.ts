import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommittingWorkspaces } from '../../src/core/app/commit-step.ts';
import { LOCAL_BRANCH, LOCAL_MARKER, LOCAL_NO_GATE_SUMMARY } from '../../src/core/app/local-workspaces.ts';
import { ProjectWorktrees } from '../../src/core/app/workspaces.ts';
import type { ExecuteResult } from '../../src/core/orchestrator/index.ts';
import type { ProjectRecord } from '../../src/core/store/index.ts';
import { defaultWorktreesRoot } from '../../src/core/workspace/index.ts';
import { taskBriefSchema, type TaskBrief, type Workspace } from '../../src/shared/index.ts';
import { cleanupDirs, tempDir } from './helpers.ts';

afterEach(async () => {
  await cleanupDirs();
});

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=Usuario', '-c', 'user.email=usuario@local', ...args], { cwd, encoding: 'utf8' });

function task(id: string, projectId: string, ownedPaths: string[]): TaskBrief {
  return taskBriefSchema.parse({ id, projectId, title: `Tarea ${id}`, objective: 'x', ownedPaths, dependsOn: [], acceptance: ['y'], difficulty: 'low' });
}

/** Resultado de ejecución mínimo con los archivos que «informó» el agente. */
function ran(files: string[], summary = 'hecho'): ExecuteResult {
  return {
    ok: true,
    outcome: 'ok',
    agentId: 'claude',
    authors: ['claude'],
    handoffs: [],
    attempts: [{ agentId: 'claude', ok: true, outcome: 'ok', filesChanged: files, texts: [], summary }],
  } as unknown as ExecuteResult;
}

/** Proyecto del almacén sin `workspace` (alta desde una carpeta sin git o sin gate). */
function localSetup(repoPath: string, id = 'local-demo') {
  const record: ProjectRecord = { id, name: 'Local', repoPath, createdAt: '2026-11-04T00:00:00.000Z' };
  const log: string[] = [];
  const pw = new ProjectWorktrees({ storeProject: (pid) => (pid === id ? record : undefined), log: (l) => log.push(l) });
  const ws = new CommittingWorkspaces({ inner: pw });
  return { id, pw, ws, log };
}

function snapshot(repo: string) {
  return {
    branches: git(repo, 'branch', '--list').stdout,
    log: git(repo, 'log', '--all', '--format=%H %s').stdout,
    stash: git(repo, 'stash', 'list').stdout,
    head: git(repo, 'rev-parse', 'HEAD').stdout.trim(),
  };
}

describe('modo local: carpeta sin git', () => {
  it('trabaja en la carpeta tal cual: sin .git, sin worktrees; resume lo informado, integra sin commit y limpia .orq', async () => {
    const root = await tempDir('orq-local-');
    const folder = join(root, 'marketing');
    mkdirSync(join(folder, '5', 'guiones'), { recursive: true });
    writeFileSync(join(folder, 'notas.md'), '# del usuario\n');
    const { id, pw, ws } = localSetup(folder);

    expect(pw.exclusiveKey(id)).toMatch(/^local:/);
    const w = await ws.create(id, task('guion-1', id, ['5/guiones/**']));
    expect(w).toEqual({ taskId: 'guion-1', path: folder, branch: LOCAL_BRANCH });
    expect(ws.isLocal(w)).toBe(true);
    expect(existsSync(join(folder, LOCAL_MARKER))).toBe(true);

    // El «agente» escribe en su ruta y, sin permiso, en otra.
    writeFileSync(join(folder, '5', 'guiones', 'video-03.md'), '# guion\n');
    writeFileSync(join(folder, 'notas.md'), '# pisado\n');
    const summary = await ws.reviewSummary(w, ran([join(folder, '5', 'guiones', 'video-03.md'), 'notas.md', '.orq/PLAN-TAREA.md']));
    expect(summary).toMatch(/^Modo local: la tarea trabajó directamente en la carpeta del usuario/);
    expect(summary).toContain('5/guiones/video-03.md');
    expect(summary).not.toContain('.orq/PLAN-TAREA.md');
    expect(summary).toMatch(/ATENCIÓN: archivos fuera de las rutas propias \(notas\.md\)/);

    const result = await ws.integrate(id, w);
    expect(result).toEqual({ ok: true, conflicts: [], gateSummary: LOCAL_NO_GATE_SUMMARY });
    await ws.remove(w);
    expect(existsSync(join(folder, '.orq'))).toBe(false);
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(readFileSync(join(folder, '5', 'guiones', 'video-03.md'), 'utf8')).toBe('# guion\n');
    expect(existsSync(defaultWorktreesRoot(id))).toBe(false);
  });

  it('la carpeta debe existir', async () => {
    const root = await tempDir('orq-local-');
    const { id, ws } = localSetup(join(root, 'no-existe'));
    await expect(ws.create(id, task('t1', id, ['src/**']))).rejects.toThrow(/la carpeta .* no existe/);
  });

  it('tras una tarea fallida, la siguiente no hereda su plan ni su HANDOFF y al terminar bien no los borra; el reintento los recupera', async () => {
    const root = await tempDir('orq-local-');
    const folder = join(root, 'proyecto');
    mkdirSync(folder, { recursive: true });
    const { id, ws } = localSetup(folder);
    const orq = (...p: string[]) => join(folder, '.orq', ...p);
    await ws.create(id, task('fallida', id, ['src/**'])); // la flota no llama a remove de una fallida
    writeFileSync(orq('PLAN-TAREA.md'), '- [x] paso de A\n');
    writeFileSync(orq('HANDOFF.md'), '# Traspaso de A\n');

    const w2 = await ws.create(id, task('otra', id, ['src/**']));
    expect(existsSync(orq('PLAN-TAREA.md'))).toBe(false);
    expect(existsSync(orq('HANDOFF.md'))).toBe(false);
    writeFileSync(orq('BRIEF.md'), '# encargo de otra\n');
    await ws.remove(w2);
    expect(readFileSync(orq('tareas', 'fallida', 'HANDOFF.md'), 'utf8')).toBe('# Traspaso de A\n');
    expect(existsSync(orq('BRIEF.md'))).toBe(false);

    const w1 = await ws.create(id, task('fallida', id, ['src/**']));
    expect(readFileSync(orq('HANDOFF.md'), 'utf8')).toBe('# Traspaso de A\n');
    expect(readFileSync(orq('PLAN-TAREA.md'), 'utf8')).toBe('- [x] paso de A\n');
    expect(existsSync(orq('tareas'))).toBe(false);
    await ws.remove(w1);
    expect(existsSync(join(folder, '.orq'))).toBe(false);
  });

  it('una marca con un dueño que no es un id válido no aparta nada fuera de .orq/tareas', async () => {
    const root = await tempDir('orq-local-');
    const folder = join(root, 'proyecto');
    mkdirSync(join(folder, '.orq'), { recursive: true });
    writeFileSync(join(folder, LOCAL_MARKER), 'x\ntarea: ../../fuera\n');
    writeFileSync(join(folder, '.orq', 'HANDOFF.md'), '# traspaso\n');
    const { id, ws } = localSetup(folder);
    const w = await ws.create(id, task('t1', id, ['src/**']));
    expect(existsSync(join(root, 'fuera'))).toBe(false);
    expect(existsSync(join(folder, '.orq', 'tareas'))).toBe(false);
    await ws.remove(w);
  });

  it('el reintento de la misma tarea, sin otra en medio, conserva su plan y su HANDOFF', async () => {
    const root = await tempDir('orq-local-');
    const folder = join(root, 'proyecto');
    mkdirSync(folder, { recursive: true });
    const { id, ws } = localSetup(folder);
    await ws.create(id, task('fallida', id, ['src/**']));
    writeFileSync(join(folder, '.orq', 'HANDOFF.md'), '# traspaso\n');
    const w = await ws.create(id, task('fallida', id, ['src/**']));
    expect(readFileSync(join(folder, '.orq', 'HANDOFF.md'), 'utf8')).toBe('# traspaso\n');
    await ws.remove(w);
    expect(existsSync(join(folder, '.orq'))).toBe(false);
  });

  it('una .orq/ previa del usuario (sin la marca) no se borra al terminar', async () => {
    const root = await tempDir('orq-local-');
    const folder = join(root, 'proyecto');
    mkdirSync(join(folder, '.orq'), { recursive: true });
    writeFileSync(join(folder, '.orq', 'propio.txt'), 'mío\n');
    const { id, ws } = localSetup(folder);
    const w = await ws.create(id, task('t1', id, ['src/**']));
    await ws.remove(w);
    expect(readFileSync(join(folder, '.orq', 'propio.txt'), 'utf8')).toBe('mío\n');
  });
});

describe('modo local: carpeta git sin gate (caso marketing)', () => {
  it('no crea ramas, commits ni stash; .orq queda fuera de git status (info/exclude) y el .gitignore no cambia', async () => {
    const root = await tempDir('orq-local-git-');
    const repo = join(root, 'marketing');
    mkdirSync(join(repo, '5'), { recursive: true });
    writeFileSync(join(repo, '5', 'a.md'), 'uno\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'inicio']]) expect(git(repo, ...args).status).toBe(0);
    const bare = join(root, 'remoto.git');
    expect(git(root, 'init', '-q', '--bare', bare).status).toBe(0);
    expect(git(repo, 'remote', 'add', 'origin', bare).status).toBe(0);
    const before = snapshot(repo);
    const { id, ws } = localSetup(repo, 'marketing');

    const w = await ws.create(id, task('t1', id, ['5/**']));
    expect(git(repo, 'status', '--porcelain').stdout).toBe('');
    // Los agentes reciben el bloqueo de push por entorno: desde la carpeta, `git push` no sale.
    const agentEnv = ws.agentEnv(w);
    expect(agentEnv?.GIT_CONFIG_PARAMETERS).toBeDefined();
    const push = spawnSync('git', ['push', '--no-verify', 'origin', 'main'], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...agentEnv } });
    expect(push.status).not.toBe(0);
    expect(git(bare, 'for-each-ref').stdout.trim()).toBe('');
    writeFileSync(join(repo, '5', 'a.md'), 'dos\n');
    await ws.reviewSummary(w, ran(['5/a.md']));
    const result = await ws.integrate(id, w);
    expect(result.ok).toBe(true);
    expect(result.commit).toBeUndefined();
    await ws.remove(w);

    expect(snapshot(repo)).toEqual(before);
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('M 5/a.md');
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.orq\/$/m);
  });
});

describe('modo local: carpeta con gate', () => {
  it('corre el gate en la carpeta: si falla la tarea no se da por buena; arreglado, pasa', async () => {
    const root = await tempDir('orq-local-gate-');
    const folder = join(root, 'app');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { check: 'node check.mjs' } }));
    writeFileSync(join(folder, 'check.mjs'), "import { readFileSync } from 'node:fs';\nif (readFileSync('estado.txt', 'utf8').includes('roto')) { console.error('gate roto'); process.exit(1); }\n");
    writeFileSync(join(folder, 'estado.txt'), 'roto\n');
    const { id, ws } = localSetup(folder);
    const w: Workspace = await ws.create(id, task('t1', id, ['estado.txt']));

    const failed = await ws.integrate(id, w);
    expect(failed.ok).toBe(false);
    expect(failed.gateSummary).toMatch(/^local: gate fallido[\s\S]*gate roto/);

    writeFileSync(join(folder, 'estado.txt'), 'bien\n');
    const passed = await ws.integrate(id, w);
    expect(passed.ok).toBe(true);
    expect(passed.gateSummary).toMatch(/^local: gate ok/);
    // Antes de revisar (issue 6): el mismo gate, sin LLM.
    expect(await ws.verify(w, task('t1', id, ['estado.txt']))).toMatchObject({ ok: true, summary: expect.stringMatching(/^local: gate ok/) });
    writeFileSync(join(folder, 'estado.txt'), 'roto\n');
    expect(await ws.verify(w, task('t1', id, ['estado.txt']))).toMatchObject({ ok: false });
    await ws.remove(w);
  }, 60_000);

  it('sin verificación en la carpeta, verify no da veredicto (lo comprueba el revisor)', async () => {
    const root = await tempDir('orq-local-gate-');
    const folder = join(root, 'sin-gate');
    mkdirSync(folder, { recursive: true });
    const { id, ws } = localSetup(folder);
    const w = await ws.create(id, task('t2', id, ['a.txt']));
    expect(await ws.verify(w, task('t2', id, ['a.txt']))).toBeUndefined();
    await ws.remove(w);
  });
});
