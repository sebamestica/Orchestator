import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitGuardError, WorktreeManager, createGitRunner, runCommand } from '../../../src/core/workspace/index.ts';
import { brief, commitFile, head, makeRepo, nodeCmd } from './helpers.ts';
import type { TempRepo } from './helpers.ts';

// Reproducciones de la revisión de agy (agy-revision-2, 2026-11-02): cada prueba fallaba antes de la corrección.

let t: TempRepo | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function setup(extra: Record<string, unknown> = {}) {
  t = makeRepo();
  const tr = t;
  const mgr = new WorktreeManager({ projects: [{ id: 'demo', repoPath: tr.repo, worktreesRoot: tr.worktreesRoot, links: ['node_modules'], ...extra }], removeRetryDelayMs: 300 });
  const git = createGitRunner({ protectedPaths: [tr.repo], managedRoots: [tr.worktreesRoot] });
  return { t: tr, mgr, git };
}

describe('revisión agy: guardia con repos reales', () => {
  it('H2: -c include.path con un alias a reset --hard se niega y el cambio sigue', async () => {
    const { t, mgr, git } = setup();
    const ws = await mgr.create('demo', brief('h2'));
    const cfg = join(t.base, 'alias.cfg');
    writeFileSync(cfg, '[alias]\n\trh = reset --hard\n');
    writeFileSync(join(ws.path, 'a.txt'), 'cambio sin guardar\n');
    await expect(git(ws.path, ['-c', `include.path=${cfg.replace(/\\/g, '/')}`, 'rh'])).rejects.toThrow(GitGuardError);
    expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('cambio sin guardar\n');
  });

  it('H1: push con -c pushInsteadOf, hooksPath vacío y --no-verify se niega en la guardia', async () => {
    const { t, mgr, git } = setup();
    const bare = join(t.base, 'remoto.git');
    t.git(t.base, 'init', '-q', '--bare', bare);
    const ws = await mgr.create('demo', brief('h1'));
    const url = bare.replace(/\\/g, '/');
    await expect(git(ws.path, ['-c', `url.${url}.pushInsteadOf=${url}`, '-c', 'core.hooksPath=', 'push', '--no-verify', url, 'orq/h1'])).rejects.toThrow(GitGuardError);
    expect(t.git(bare, 'for-each-ref').trim()).toBe('');
  });

  it('H3: clean --dry-run --no-dry-run -f -d -x se niega y no borra', async () => {
    const { mgr, git } = setup();
    const ws = await mgr.create('demo', brief('h3'));
    writeFileSync(join(ws.path, 'nuevo.txt'), 'x');
    await expect(git(ws.path, ['clean', '--dry-run', '--no-dry-run', '-f', '-d', '-x'])).rejects.toThrow(GitGuardError);
    expect(existsSync(join(ws.path, 'nuevo.txt'))).toBe(true);
  });

  it('H4: branch -m y update-ref con 40 ceros no hacen desaparecer orq/integracion', async () => {
    const { t, mgr, git } = setup();
    const ws = await mgr.create('demo', brief('h4'));
    await expect(git(ws.path, ['branch', '-m', 'orq/integracion', 'orq/borrada'])).rejects.toThrow(GitGuardError);
    await expect(git(ws.path, ['update-ref', 'refs/heads/orq/integracion', '0'.repeat(40)])).rejects.toThrow(GitGuardError);
    expect(t.git(t.repo, 'branch', '--list', 'orq/integracion').trim()).toContain('orq/integracion');
  });

  it('H5: read-tree en la copia del usuario y GIT_DIR/GIT_WORK_TREE (pasadas o heredadas) no la tocan', async () => {
    const { t, mgr, git } = setup();
    const ws = await mgr.create('demo', brief('h5'));
    writeFileSync(join(t.repo, 'a.txt'), 'trabajo del usuario\n');
    await expect(git(t.repo, ['read-tree', '-u', '--reset', 'HEAD'])).rejects.toThrow(GitGuardError);
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('trabajo del usuario\n');
    const redirect = { GIT_DIR: join(t.repo, '.git'), GIT_WORK_TREE: t.repo };
    await expect(git(ws.path, ['checkout', '-q', 'orq/h5'], { env: redirect })).rejects.toThrow(GitGuardError);
    await expect(git(ws.path, ['status', '--porcelain'], { env: redirect })).rejects.toThrow(GitGuardError);
    const saved = { dir: process.env.GIT_DIR, wt: process.env.GIT_WORK_TREE };
    Object.assign(process.env, redirect);
    try {
      expect((await git(ws.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('orq/h5');
    } finally {
      for (const [k, v] of [['GIT_DIR', saved.dir], ['GIT_WORK_TREE', saved.wt]] as const) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
    expect(t.git(t.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('trabajo del usuario\n');
  });
});

describe('revisión agy: gestor e integración', () => {
  it('H6: postCreate que deja archivos y falla no deja el worktree atascado', async () => {
    const { t, mgr } = setup({ postCreate: [nodeCmd("require('fs').writeFileSync('log-instalacion.txt', 'x'); process.exit(1)")] });
    await expect(mgr.create('demo', brief('h6'))).rejects.toThrow(/postCreate falló/);
    const path = join(t.worktreesRoot, 'h6');
    expect(existsSync(path)).toBe(false);
    expect(t.git(t.repo, 'worktree', 'list', '--porcelain')).not.toContain('h6');
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
  });

  it('H7: recrear el worktree de una tarea reutiliza su rama (y sus commits)', async () => {
    const { t, mgr } = setup();
    const ws = await mgr.create('demo', brief('h7'));
    commitFile(t, ws.path, 'h7.txt', 'trabajo previo\n');
    const before = head(t, ws.path);
    await mgr.remove(ws);
    const again = await mgr.create('demo', brief('h7'));
    expect(again.branch).toBe('orq/h7');
    expect(head(t, again.path)).toBe(before);
    expect(readFileSync(join(again.path, 'h7.txt'), 'utf8')).toBe('trabajo previo\n');
  });

  it('H8: crear e integrar a la vez en el mismo proyecto no choca', async () => {
    const { t, mgr } = setup();
    const a = await mgr.create('demo', brief('h8-a'));
    commitFile(t, a.path, 'h8.txt', 'a\n');
    const [res, b, c] = await Promise.all([mgr.integrate('demo', a), mgr.create('demo', brief('h8-b')), mgr.create('demo', brief('h8-c'))]);
    expect(res.ok).toBe(true);
    expect(existsSync(b.path) && existsSync(c.path)).toBe(true);
  });

  it('H11: restos no versionados de un gate fallido no bloquean la siguiente integración', async () => {
    const { t, mgr } = setup({ gate: [nodeCmd("const fs = require('fs'); if (!fs.existsSync('ok.txt')) { fs.writeFileSync('dist.txt', 'resto'); process.exit(1); }")] });
    const a = await mgr.create('demo', brief('h11-a'));
    commitFile(t, a.path, 'a2.txt', 'a\n');
    expect((await mgr.integrate('demo', a)).ok).toBe(false);
    const b = await mgr.create('demo', brief('h11-b'));
    commitFile(t, b.path, 'dist.txt', 'versionado\n');
    commitFile(t, b.path, 'ok.txt', 'ok\n');
    const res = await mgr.integrate('demo', b);
    expect(res.gateSummary).toMatch(/gate ok/);
    expect(res.ok).toBe(true);
    expect(t.git(t.repo, 'show', 'orq/integracion:dist.txt')).toBe('versionado\n');
  });

  it('H12: una rama que empieza por guion no llega a git merge como opción', async () => {
    const { t, mgr } = setup();
    await mgr.create('demo', brief('h12-base'));
    const before = head(t, t.repo, 'orq/integracion');
    const res = await mgr.integrate('demo', { taskId: 'h12', path: join(t.worktreesRoot, 'h12'), branch: '-s' });
    expect(res.ok).toBe(false);
    expect(res.gateSummary).toMatch(/nombre de rama no válido/);
    expect(head(t, t.repo, 'orq/integracion')).toBe(before);
  });

  it('H10: un archivo en links se enlaza (enlace duro) y quitar el worktree no lo borra', async () => {
    t = makeRepo();
    writeFileSync(join(t.repo, 'compartido.json'), '{"a":1}');
    const mgr = new WorktreeManager({ projects: [{ id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot, links: ['compartido.json'] }] });
    const ws = await mgr.create('demo', brief('h10'));
    expect(readFileSync(join(ws.path, 'compartido.json'), 'utf8')).toBe('{"a":1}');
    expect(t.git(ws.path, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('');
    await mgr.remove(ws);
    expect(readFileSync(join(t.repo, 'compartido.json'), 'utf8')).toBe('{"a":1}');
  });
});

describe('revisión agy: comandos del gate en Windows (H9)', () => {
  it.runIf(process.platform === 'win32')('lanza .cmd sin EINVAL, niega metacaracteres y no lanza excepciones', async () => {
    t = makeRepo();
    // El .cmd está fuera del cwd (un ejecutable dentro del worktree nunca se lanza: revisión de Codex c13, H1).
    const cmd = join(t.base, 'gate.cmd');
    writeFileSync(cmd, '@echo gate-ok %1\r\n');
    const ok = await runCommand({ command: cmd, args: ['uno'], timeoutMs: 30_000, env: {} }, t.repo);
    expect(ok.ok).toBe(true);
    expect(ok.tail.join('\n')).toContain('gate-ok uno');
    const marker = join(t.base, 'inyectado.txt');
    const bad = await runCommand({ command: cmd, args: [`x&echo y>${marker}`], timeoutMs: 30_000, env: {} }, t.repo);
    expect(bad.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const inside = await runCommand({ command: cmd, args: ['uno'], timeoutMs: 30_000, env: {} }, t.base);
    expect(inside.ok).toBe(false);
    expect(inside.tail.join('\n')).toMatch(/dentro de una carpeta de los agentes/);
    const nul = await runCommand({ command: process.execPath, args: ['-e', '\0'], timeoutMs: 30_000, env: {} }, t.base);
    expect(nul.ok).toBe(false);
    expect(nul.tail.join('\n')).toMatch(/no se pudo lanzar/);
  });
});
