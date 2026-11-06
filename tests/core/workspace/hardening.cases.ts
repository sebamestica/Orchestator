import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEGRATION_DIR, WorktreeManager } from '../../../src/core/workspace/index.ts';
import { brief, commitFile, makeRepo, nodeCmd } from './helpers.ts';
import type { TempRepo } from './helpers.ts';

// Revisión de Codex sobre c13 con repos git reales: H3 (enlaces), H4 (exclusión por repo físico) y H6 (borrado).
// Las H4 llevan su tope en el tercer argumento de `it`; el resto usa el de `repos.test.ts`.
const H4_TIMEOUT = 240_000;

let t: TempRepo | undefined;
const restore: (() => void)[] = [];
/** `abrir` de cada barrera de la prueba en curso y el trabajo que sigue corriendo (gates, integraciones). */
const barriers: string[] = [];
const pending: Promise<unknown>[] = [];

// Antes de borrar la carpeta: si la prueba se cortó con una barrera cerrada, el gate seguiría vivo con su cwd dentro
// (Windows no deja borrarla) y la integración haría su rollback sobre una carpeta vacía.
afterEach(async () => {
  for (const open of barriers.splice(0)) writeFileSync(open, '');
  await settle(pending.splice(0), 90_000);
  for (const fn of restore.splice(0)) fn();
  t?.cleanup();
  t = undefined;
}, 120_000);

const win = process.platform === 'win32';
const execFileAsync = promisify(execFile);

/** Espera a que terminen las promesas, o `ms` como mucho. */
async function settle(promises: Promise<unknown>[], ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((r) => { timer = setTimeout(r, ms); });
  await Promise.race([Promise.allSettled(promises), limit]);
  clearTimeout(timer);
}

/** Registra trabajo que puede seguir vivo si la prueba se corta: `afterEach` lo espera antes de borrar. */
function track<T>(p: Promise<T>): Promise<T> {
  // Con su manejador desde ya: si la prueba se corta antes de esperarla, su rechazo no queda sin manejar.
  pending.push(p.catch(() => undefined));
  return p;
}

/** Gate que avisa que empezó y espera a que exista `abrir` (barrera), con un tope para no colgar la suite. */
function barrierGate(dir: string) {
  const started = join(dir, 'gate-empezo');
  const open = join(dir, 'abrir');
  const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'');const t0=Date.now();const w=()=>{if(fs.existsSync(${JSON.stringify(open)}))process.exit(0);if(Date.now()-t0>60000)process.exit(9);setTimeout(w,50)};w()`;
  barriers.push(open);
  return { spec: nodeCmd(code), started, open };
}

async function until(cond: () => boolean, ms = 45_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('tiempo agotado esperando la condición');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Ventana medida en git y no en milisegundos: lo que tardan `n` git seguidos ahora mismo. Con la máquina cargada se
 * alarga al mismo ritmo que los git de la integración que se espera ver bloqueada.
 */
async function gitWindow(cwd: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, windowsHide: true });
}

describe('H6: una carpeta que no se puede listar bloquea el borrado', () => {
  it.runIf(win)('remove falla sin tocar nada si no puede revisar todo el worktree; tras arreglarlo, quita y conserva la copia', async () => {
    t = makeRepo();
    const mgr = new WorktreeManager({ projects: [{ id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot, links: ['node_modules'] }], removeRetries: 0 });
    const ws = await mgr.create('demo', brief('acl'));
    // Una junction escondida en una carpeta ignorada que la flota no puede listar.
    const hidden = join(ws.path, 'node_modules_local');
    mkdirSync(hidden);
    symlinkSync(join(t.repo, 'node_modules'), join(hidden, 'node_modules'), 'junction');
    mkdirSync(join(t.repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(t.repo, '.git', 'info', 'exclude'), '/node_modules_local\n', { flag: 'a' });
    const user = userInfo().username;
    execFileSync('icacls', [hidden, '/deny', `${user}:(RD)`], { stdio: 'ignore' });
    restore.push(() => execFileSync('icacls', [hidden, '/remove:d', user], { stdio: 'ignore' }));

    await expect(mgr.remove(ws)).rejects.toThrow(/no se pudo revisar .*node_modules_local.*no se borra/);
    expect(existsSync(join(ws.path, '.git'))).toBe(true);
    expect(t.git(t.repo, 'worktree', 'list', '--porcelain')).toContain('acl');
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');

    (restore.pop() as () => void)();
    await mgr.remove(ws);
    expect(existsSync(ws.path)).toBe(false);
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
  });
});

describe('H3: un enlace que sale del repo no se crea', () => {
  it.runIf(win)('create falla, deshace el worktree y no da acceso a la carpeta de fuera', async () => {
    t = makeRepo();
    const outside = join(t.base, 'fuera');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secreto.txt'), 'de fuera');
    symlinkSync(outside, join(t.repo, 'recursos'), 'junction');
    mkdirSync(join(t.repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(t.repo, '.git', 'info', 'exclude'), '/recursos\n', { flag: 'a' });
    const mgr = new WorktreeManager({ projects: [{ id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot, links: ['recursos'] }] });
    await expect(mgr.create('demo', brief('escape'))).rejects.toThrow(/sale del repo/);
    expect(existsSync(join(t.worktreesRoot, 'escape'))).toBe(false);
    expect(readdirSync(outside)).toEqual(['secreto.txt']);
  });
});

describe('H4: integraciones del mismo repo físico, en serie aunque sean de gestores distintos', () => {
  it('dos gestores (configuración vieja y nueva, misma raíz) no intercalan merge, gate ni commit', async () => {
    t = makeRepo();
    const barrier = barrierGate(t.base);
    const base = { id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot };
    const viejo = new WorktreeManager({ projects: [{ ...base, gate: [barrier.spec] }] });
    const wsA = await viejo.create('demo', brief('tarea-a'));
    const nuevo = new WorktreeManager({ projects: [{ ...base, gate: [nodeCmd('process.exit(0)')] }] });
    const wsB = await nuevo.create('demo', brief('tarea-b'));
    commitFile(t, wsA.path, 'a-nuevo.txt', 'A\n');
    commitFile(t, wsB.path, 'b-nuevo.txt', 'B\n');

    const a = track(viejo.integrate('demo', wsA));
    await until(() => existsSync(barrier.started));
    let bDone = false;
    const b = track(nuevo.integrate('demo', wsB).finally(() => { bDone = true; }));
    // Mientras el gate de A espera, B no empieza: sin la cola común, B abortaría el merge a medias de A.
    await gitWindow(t.repo, 6);
    expect(bDone).toBe(false);
    writeFileSync(barrier.open, '');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ ok: true });
    expect(rb).toMatchObject({ ok: true });
    expect(t.git(t.repo, 'show', 'orq/integracion:a-nuevo.txt')).toBe('A\n');
    expect(t.git(t.repo, 'show', 'orq/integracion:b-nuevo.txt')).toBe('B\n');
    const log = t.git(t.repo, 'log', '--format=%s', '-2', 'orq/integracion').trim().split('\n');
    expect(log).toEqual(['merge: integra orq/tarea-b (tarea tarea-b)', 'merge: integra orq/tarea-a (tarea tarea-a)']);
  }, H4_TIMEOUT);
});

describe('H4 (2.ª revisión): la cola es por repositorio git común, no por carpeta', () => {
  it('dos gestores cuyas copias son worktrees del mismo repo (mismo git-common-dir) integran en serie', async () => {
    t = makeRepo();
    const linked = join(t.base, 'copia-enlazada');
    t.git(t.repo, 'worktree', 'add', '-q', '--relative-paths', linked, '-b', 'base-2', 'main');
    const barrier = barrierGate(t.base);
    const bGate = join(t.base, 'b-gate');
    const uno = new WorktreeManager({ projects: [{ id: 'uno', repoPath: t.repo, worktreesRoot: join(t.base, 'wt-uno'), gate: [barrier.spec] }] });
    const dos = new WorktreeManager({
      projects: [{ id: 'dos', repoPath: linked, worktreesRoot: join(t.base, 'wt-dos'), baseBranch: 'base-2', integrationBranch: 'orq/integracion-dos', gate: [nodeCmd(`require('fs').writeFileSync(${JSON.stringify(bGate)},'')`)] }],
    });
    const wsA = await uno.create('uno', brief('tarea-a'));
    const wsB = await dos.create('dos', brief('tarea-b'));
    commitFile(t, wsA.path, 'a-nuevo.txt', 'A\n');
    commitFile(t, wsB.path, 'b-nuevo.txt', 'B\n');
    const a = track(uno.integrate('uno', wsA));
    await until(() => existsSync(barrier.started));
    const b = track(dos.integrate('dos', wsB));
    // Sin la cola por git-common-dir, B arma su `_integracion` en su 3.er git y llega a su gate mientras A espera.
    await gitWindow(t.repo, 6);
    expect(existsSync(join(t.base, 'wt-dos', INTEGRATION_DIR))).toBe(false);
    expect(existsSync(bGate)).toBe(false);
    writeFileSync(barrier.open, '');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ ok: true });
    expect(rb).toMatchObject({ ok: true });
    // El gate de B corrió después de que se abrió la barrera de A.
    expect(statSync(bGate).mtimeMs).toBeGreaterThanOrEqual(statSync(barrier.open).mtimeMs);
    expect(t.git(t.repo, 'show', 'orq/integracion-dos:b-nuevo.txt')).toBe('B\n');
  }, H4_TIMEOUT);
});

describe('H4 (barrera cortada): una prueba que termina sin abrir la barrera no deja el gate vivo ni la carpeta', () => {
  let cut: { base: string; gate: ChildProcess } | undefined;
  it('la prueba se corta con el gate esperando la barrera', async () => {
    t = makeRepo();
    const barrier = barrierGate(t.base);
    const gate = spawn(barrier.spec.command, barrier.spec.args ?? [], { cwd: t.repo, stdio: 'ignore', windowsHide: true });
    track(new Promise((r) => gate.once('exit', r)));
    cut = { base: t.base, gate };
    await until(() => existsSync(barrier.started));
  });
  it('afterEach abrió la barrera, esperó al gate y borró la carpeta', () => {
    expect(cut, 'corre después de la prueba anterior').toBeDefined();
    expect(cut?.gate.exitCode).toBe(0);
    expect(existsSync(cut?.base ?? '')).toBe(false);
  });
});
