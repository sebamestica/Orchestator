import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitGuardError, WorkspaceError, WorktreeManager, createGitRunner } from '../../../src/core/workspace/index.ts';
import { brief, head, makeRepo, nodeCmd } from './helpers.ts';
import type { TempRepo } from './helpers.ts';

// Repos git reales: con la flota corriendo en paralelo el equipo va cargado.
vi.setConfig({ testTimeout: 90_000 });

let t: TempRepo | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function setup(extra: Record<string, unknown> = {}): { t: TempRepo; mgr: WorktreeManager } {
  t = makeRepo();
  const mgr = new WorktreeManager({
    projects: [{ id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot, links: ['node_modules', 'workbench', 'no-existe'], ...extra }],
    removeRetries: 30,
    removeRetryDelayMs: 300,
  });
  return { t, mgr };
}

describe('WorktreeManager.create', () => {
  it('crea el worktree en orq/<tarea> desde la integración, con enlaces y postCreate', async () => {
    const { t, mgr } = setup({ postCreate: [nodeCmd("require('fs').writeFileSync('.postcreate-ok', process.cwd())")] });
    const userHead = head(t, t.repo);
    const ws = await mgr.create('demo', brief('tarea-1'));

    expect(ws).toEqual({ taskId: 'tarea-1', path: join(t.worktreesRoot, 'tarea-1'), branch: 'orq/tarea-1' });
    expect(t.git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('orq/tarea-1');
    expect(head(t, ws.path)).toBe(head(t, t.repo, 'orq/integracion'));
    // Enlaces a la copia principal (junction en Windows).
    expect(lstatSync(join(ws.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(ws.path, 'node_modules'))).toBe(realpathSync(join(t.repo, 'node_modules')));
    expect(readFileSync(join(ws.path, 'workbench', 'keep.txt'), 'utf8')).toBe('no borrar');
    expect(existsSync(join(ws.path, 'no-existe'))).toBe(false);
    // Los enlaces no aparecen como cambios: un `git add -A` del agente no los versiona.
    expect(t.git(ws.path, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('');
    // postCreate corrió dentro del worktree.
    expect(realpathSync(readFileSync(join(ws.path, '.postcreate-ok'), 'utf8'))).toBe(realpathSync(ws.path));
    // La copia del usuario sigue en su rama y commit.
    expect(t.git(t.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(head(t, t.repo)).toBe(userHead);
    // Rutas relativas (--relative-paths).
    expect(readFileSync(join(ws.path, '.git'), 'utf8')).not.toContain(t.base);
  });

  it('si postCreate falla, quita la carpeta y conserva la rama', async () => {
    const { t, mgr } = setup({ postCreate: [nodeCmd("console.error('fallo de prueba'); process.exit(3)")] });
    await expect(mgr.create('demo', brief('tarea-2'))).rejects.toThrow(/postCreate falló[\s\S]*código 3[\s\S]*fallo de prueba/);
    expect(existsSync(join(t.worktreesRoot, 'tarea-2'))).toBe(false);
    expect(t.git(t.repo, 'branch', '--list', 'orq/tarea-2').trim()).toContain('orq/tarea-2');
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
  });

  it('postCreate con timeout no se queda colgado', async () => {
    const { mgr } = setup({ postCreate: [nodeCmd('setTimeout(() => {}, 60000)', { timeoutMs: 500 })] });
    await expect(mgr.create('demo', brief('tarea-3'))).rejects.toThrow(/tiempo agotado/);
  });

  it('rechaza proyectos sin configuración y tareas repetidas', async () => {
    const { mgr } = setup();
    await expect(mgr.create('otro', brief('tarea-4'))).rejects.toThrow(WorkspaceError);
    await mgr.create('demo', brief('tarea-4'));
    await expect(mgr.create('demo', brief('tarea-4'))).rejects.toThrow(/ya existe/);
  });
});

describe('WorktreeManager.remove', () => {
  it('quita el worktree sin borrar la rama ni el contenido enlazado de la copia principal', async () => {
    const { t, mgr } = setup();
    const ws = await mgr.create('demo', brief('tarea-5'));
    await mgr.remove(ws);
    expect(existsSync(ws.path)).toBe(false);
    expect(t.git(t.repo, 'branch', '--list', 'orq/tarea-5').trim()).toContain('orq/tarea-5');
    expect(t.git(t.repo, 'worktree', 'list', '--porcelain')).not.toContain('tarea-5');
    // git worktree remove recorre una junction ignorada: sin quitar antes los enlaces borraría esto.
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
    expect(readFileSync(join(t.repo, 'workbench', 'keep.txt'), 'utf8')).toBe('no borrar');
    // Quitar dos veces no falla (worktree ya inexistente: prune).
    await expect(mgr.remove(ws)).resolves.toBeUndefined();
  });

  it('no quita un worktree con cambios sin confirmar y deja sus enlaces', async () => {
    const { mgr } = setup();
    const ws = await mgr.create('demo', brief('tarea-6'));
    writeFileSync(join(ws.path, 'a.txt'), 'trabajo sin guardar\n');
    await expect(mgr.remove(ws)).rejects.toThrow(/cambios sin confirmar/);
    expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('trabajo sin guardar\n');
    expect(lstatSync(join(ws.path, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('también quita enlaces creados por el agente dentro del worktree', async () => {
    const { t, mgr } = setup({ links: [] });
    const ws = await mgr.create('demo', brief('tarea-7'));
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(t.repo, 'node_modules'), join(ws.path, 'node_modules'), 'junction');
    await mgr.remove(ws);
    expect(existsSync(ws.path)).toBe(false);
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
  });

  it('termina un remove interrumpido y nunca borra carpetas que no son worktrees de tarea', async () => {
    const { t, mgr } = setup();
    const ws = await mgr.create('demo', brief('tarea-9'));
    // Simula un remove anterior que git dejó a medias: sin `.git` y ya desregistrado, con la junction dentro.
    rmSync(join(ws.path, '.git'));
    t.git(t.repo, 'worktree', 'prune');
    await mgr.remove(ws);
    expect(existsSync(ws.path)).toBe(false);
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
    const hooks = { taskId: 'hooks', path: join(t.worktreesRoot, '_hooks'), branch: 'orq/hooks' };
    await expect(mgr.remove(hooks)).rejects.toThrow(/no es un worktree registrado/);
    expect(existsSync(join(t.worktreesRoot, '_hooks', 'pre-push'))).toBe(true);
  });

  it('reintenta mientras otro proceso retiene la carpeta (EPERM/EBUSY en Windows)', async () => {
    const { mgr } = setup();
    const ws = await mgr.create('demo', brief('tarea-8'));
    // Un proceso con cwd en el worktree lo retiene ~1,5 s, como el CLI de Claude al cerrarse.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { cwd: ws.path, stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 200));
    await mgr.remove(ws);
    expect(existsSync(ws.path)).toBe(false);
    holder.kill();
  });
});

describe('guardia dentro del módulo', () => {
  it('el ejecutor de git niega checkout en la copia del usuario sin lanzar git', async () => {
    t = makeRepo();
    const git = createGitRunner({ protectedPaths: [t.repo] });
    await expect(git(t.repo, ['checkout', '-b', 'otra'])).rejects.toThrow(GitGuardError);
    await expect(git(t.repo, ['push', 'origin', 'main'])).rejects.toThrow(GitGuardError);
    expect(t.git(t.repo, 'branch', '--list', 'otra').trim()).toBe('');
    const ok = await git(t.repo, ['status', '--porcelain']);
    expect(ok.code).toBe(0);
  });
});
