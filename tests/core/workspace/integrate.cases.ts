import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from '../../../src/core/workspace/index.ts';
import { brief, commitFile, head, makeRepo, nodeCmd } from './helpers.ts';
import type { TempRepo } from './helpers.ts';

let t: TempRepo | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function setup(gate: unknown[] = []): { t: TempRepo; mgr: WorktreeManager; integ: string } {
  t = makeRepo();
  const mgr = new WorktreeManager({ projects: [{ id: 'demo', repoPath: t.repo, worktreesRoot: t.worktreesRoot, links: ['node_modules'], gate }] });
  return { t, mgr, integ: join(t.worktreesRoot, '_integracion') };
}

/** Estado del worktree de integración: sin merge a medias ni cambios en archivos versionados. */
function assertCleanIntegration(t: TempRepo, integ: string): void {
  expect(existsSync(join(t.repo, '.git', 'worktrees', '_integracion', 'MERGE_HEAD'))).toBe(false);
  expect(t.git(integ, 'status', '--porcelain', '--untracked-files=no').trim()).toBe('');
}

describe('WorktreeManager.integrate', () => {
  it('merge limpio: --no-ff en el worktree de integración, gate ok y commit; la copia del usuario no cambia', async () => {
    const { t, mgr, integ } = setup([nodeCmd("require('fs').existsSync('b.txt') || process.exit(1); console.log('gate visto')")]);
    const userHead = head(t, t.repo);
    const ws = await mgr.create('demo', brief('tarea-a'));
    commitFile(t, ws.path, 'b.txt', 'de la tarea\n');
    const taskHead = head(t, ws.path);

    const res = await mgr.integrate('demo', ws);
    expect(res.ok).toBe(true);
    expect(res.conflicts).toEqual([]);
    expect(res.gateSummary).toMatch(/gate ok \(1 comandos\)/);
    expect(res.commit).toBe(head(t, t.repo, 'orq/integracion'));
    // Commit de merge con dos padres (no fast-forward) y el mensaje del orquestador.
    const parents = t.git(t.repo, 'rev-list', '--parents', '-n', '1', 'orq/integracion').trim().split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(taskHead);
    expect(t.git(t.repo, 'log', '-1', '--format=%s', 'orq/integracion').trim()).toBe('merge: integra orq/tarea-a (tarea tarea-a)');
    expect(readFileSync(join(integ, 'b.txt'), 'utf8')).toBe('de la tarea\n');
    // La copia del usuario: misma rama, mismo commit, sin el archivo.
    expect(t.git(t.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(head(t, t.repo)).toBe(userHead);
    expect(head(t, t.repo, 'main')).toBe(userHead);
    expect(existsSync(join(t.repo, 'b.txt'))).toBe(false);
    assertCleanIntegration(t, integ);
  });

  it('conflicto: devuelve los archivos, aborta y no deja commit ni merge a medias', async () => {
    const { t, mgr, integ } = setup([nodeCmd("require('fs').writeFileSync('gate-corrio.txt', 'x')")]);
    const a = await mgr.create('demo', brief('tarea-b'));
    const b = await mgr.create('demo', brief('tarea-c'));
    commitFile(t, a.path, 'a.txt', 'version de b\n');
    commitFile(t, b.path, 'a.txt', 'version de c\n');
    expect((await mgr.integrate('demo', a)).ok).toBe(true);
    const before = head(t, t.repo, 'orq/integracion');

    const res = await mgr.integrate('demo', b);
    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(['a.txt']);
    expect(res.commit).toBeUndefined();
    expect(res.gateSummary).toMatch(/no ejecutado: el merge falló con 1 conflicto/);
    expect(head(t, t.repo, 'orq/integracion')).toBe(before);
    expect(readFileSync(join(integ, 'a.txt'), 'utf8')).toBe('version de b\n');
    assertCleanIntegration(t, integ);
    // Tras abortar se puede seguir integrando otras tareas.
    const d = await mgr.create('demo', brief('tarea-d'));
    commitFile(t, d.path, 'd.txt', 'd\n');
    expect((await mgr.integrate('demo', d)).ok).toBe(true);
  });

  it('gate fallido: aborta el merge, no deja commit y resume la salida', async () => {
    const { t, mgr, integ } = setup([
      nodeCmd("console.log('primer paso ok')"),
      nodeCmd("console.error('2 pruebas fallidas'); process.exit(1)"),
      nodeCmd("require('fs').writeFileSync('no-debe-correr.txt', 'x')"),
    ]);
    const ws = await mgr.create('demo', brief('tarea-e'));
    commitFile(t, ws.path, 'e.txt', 'e\n');
    const before = head(t, t.repo, 'orq/integracion');

    const res = await mgr.integrate('demo', ws);
    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual([]);
    expect(res.commit).toBeUndefined();
    expect(res.gateSummary).toMatch(/gate fallido \(2\/3 comandos\)/);
    expect(res.gateSummary).toMatch(/falló \(código 1\)/);
    expect(res.gateSummary).toMatch(/2 pruebas fallidas/);
    expect(head(t, t.repo, 'orq/integracion')).toBe(before);
    expect(existsSync(join(integ, 'e.txt'))).toBe(false);
    expect(existsSync(join(integ, 'no-debe-correr.txt'))).toBe(false);
    assertCleanIntegration(t, integ);
  });

  it('gate con timeout también aborta', async () => {
    const { t, mgr, integ } = setup([nodeCmd('setTimeout(() => {}, 60000)', { timeoutMs: 500 })]);
    const ws = await mgr.create('demo', brief('tarea-f'));
    commitFile(t, ws.path, 'f.txt', 'f\n');
    const before = head(t, t.repo, 'orq/integracion');
    const res = await mgr.integrate('demo', ws);
    expect(res.ok).toBe(false);
    expect(res.gateSummary).toMatch(/tiempo agotado/);
    expect(head(t, t.repo, 'orq/integracion')).toBe(before);
    assertCleanIntegration(t, integ);
  });

  it('el gate no filtra claves en el resumen', async () => {
    const { mgr, t } = setup([nodeCmd("console.error('token sk-ant-api03-' + 'a'.repeat(40)); process.exit(2)")]);
    const ws = await mgr.create('demo', brief('tarea-g'));
    commitFile(t, ws.path, 'g.txt', 'g\n');
    const res = await mgr.integrate('demo', ws);
    expect(res.ok).toBe(false);
    expect(res.gateSummary).not.toMatch(/sk-ant-api03-a{10}/);
  });

  it('serializa integraciones simultáneas del mismo proyecto', async () => {
    const { t, mgr } = setup();
    const tareas = await Promise.all(['tarea-h', 'tarea-i', 'tarea-j'].map((id) => mgr.create('demo', brief(id))));
    tareas.forEach((ws, i) => commitFile(t, ws.path, `n${String(i)}.txt`, `${String(i)}\n`));
    const res = await Promise.all(tareas.map((ws) => mgr.integrate('demo', ws)));
    expect(res.map((r) => r.ok)).toEqual([true, true, true]);
    expect(t.git(t.repo, 'rev-list', '--merges', '--count', 'orq/integracion').trim()).toBe('3');
  });

  it('gate que modifica un archivo versionado: no confirma, vuelve con el motivo y no ensucia la integración', async () => {
    const { t, mgr, integ } = setup([nodeCmd("require('fs').appendFileSync('a.txt','x')")]);
    const b = await mgr.create('demo', brief('tarea-m'));
    const c = await mgr.create('demo', brief('tarea-n'));
    commitFile(t, b.path, 'b.txt', 'b\n');
    commitFile(t, c.path, 'c.txt', 'c\n');
    const before = head(t, t.repo, 'orq/integracion');
    for (const ws of [b, c]) {
      const res = await mgr.integrate('demo', ws);
      expect(res.ok).toBe(false);
      expect(res.gateSummary).toMatch(/el gate modificó archivos versionados: a\.txt/);
      expect(head(t, t.repo, 'orq/integracion')).toBe(before);
      assertCleanIntegration(t, integ);
    }
  });

  it('gate fallido que modificó un archivo versionado del merge: no lanza ni deja MERGE_HEAD, y la siguiente se integra', async () => {
    const { t, mgr, integ } = setup([nodeCmd("const fs = require('fs'); if (fs.existsSync('b.txt')) { fs.appendFileSync('b.txt', 'x'); process.exit(1); }")]);
    const b = await mgr.create('demo', brief('tarea-o'));
    commitFile(t, b.path, 'b.txt', 'b\n');
    const res = await mgr.integrate('demo', b);
    expect(res.ok).toBe(false);
    expect(res.gateSummary).toMatch(/gate fallido/);
    assertCleanIntegration(t, integ);
    const c = await mgr.create('demo', brief('tarea-p'));
    commitFile(t, c.path, 'c.txt', 'c\n');
    expect((await mgr.integrate('demo', c)).ok).toBe(true);
    assertCleanIntegration(t, integ);
    // Al recrear la carpeta, el enlace se quita sin seguirlo: la copia del usuario queda intacta y se vuelve a enlazar.
    expect(readFileSync(join(t.repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
    expect(existsSync(join(integ, 'node_modules', 'paquete', 'keep.txt'))).toBe(true);
  });

  it('cambios versionados que quedaron en la integración (otra versión, proceso cortado) se recuperan', async () => {
    const { t, mgr, integ } = setup();
    const b = await mgr.create('demo', brief('tarea-q'));
    commitFile(t, b.path, 'b.txt', 'b\n');
    expect((await mgr.integrate('demo', b)).ok).toBe(true);
    writeFileSync(join(integ, 'a.txt'), 'sucio\n');
    const c = await mgr.create('demo', brief('tarea-r'));
    commitFile(t, c.path, 'c.txt', 'c\n');
    expect((await mgr.integrate('demo', c)).ok).toBe(true);
    expect(t.git(t.repo, 'show', 'orq/integracion:a.txt')).toBe('linea original\n');
    assertCleanIntegration(t, integ);
  });

  it('rama ya integrada o inexistente', async () => {
    const { t, mgr } = setup();
    const ws = await mgr.create('demo', brief('tarea-k'));
    const same = await mgr.integrate('demo', ws);
    expect(same).toMatchObject({ ok: true, conflicts: [] });
    expect(same.commit).toBeUndefined();
    const ghost = await mgr.integrate('demo', { taskId: 'fantasma', path: join(t.worktreesRoot, 'fantasma'), branch: 'orq/fantasma' });
    expect(ghost.ok).toBe(false);
    expect(ghost.gateSummary).toMatch(/no existe/);
  });
});
