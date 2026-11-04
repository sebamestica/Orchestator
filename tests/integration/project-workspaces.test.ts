import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorktrees } from '../../src/core/app/workspaces.ts';
import { SqliteStore, type ProjectRecord } from '../../src/core/store/index.ts';
import { defaultWorktreesRoot } from '../../src/core/workspace/index.ts';
import type { TaskBrief } from '../../src/shared/index.ts';
import { cleanupDirs, tempDir } from './helpers.ts';

// Repos git reales, npm y junctions en Windows: con la flota en paralelo el equipo va cargado.
vi.setConfig({ testTimeout: 180_000 });

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await cleanupDirs();
});

const docsDir = new URL('../../docs/proyectos/', import.meta.url);
/** Cuerpo de `POST /projects` de la receta (el archivo que se envía con `-InFile`). */
const recipe = JSON.parse(readFileSync(new URL('vetworld.json', docsDir), 'utf8')) as ProjectRecord & { workspace: NonNullable<ProjectRecord['workspace']> };
const LINKS = ['.tools', 'workbench', 'assets-source', 'node_modules'] as const;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** Copia principal con la forma de Vetworld: carpetas ignoradas enlazadas, skills en `.agents` y `npm run gate`. */
async function vetworldLike(): Promise<{ base: string; repo: string }> {
  const base = realpathSync.native(await tempDir('orq-vetworld-'));
  const repo = join(base, 'Vetworld');
  mkdirSync(repo);
  git(repo, 'init', '-q', '--template=', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(join(repo, '.gitignore'), 'node_modules/\nworkbench/\n.tools/\nassets-source/\n.claude/skills/\n');
  // El gate mira a través de las junctions (node_modules de Windows y los recursos de la copia principal).
  write(join(repo, 'package.json'), `${JSON.stringify({ name: 'vetworld-fixture', private: true, scripts: { gate: 'node scripts/qa/gate.mjs' } }, null, 2)}\n`);
  write(
    join(repo, 'scripts', 'qa', 'gate.mjs'),
    "import { readFileSync } from 'node:fs';\nfor (const f of ['node_modules/paquete/keep.txt', '.tools/keep.txt', 'assets-source/keep.txt']) readFileSync(f);\nconsole.log('gate del fixture: ok');\n",
  );
  write(join(repo, '.agents', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
  write(join(repo, '.agents', 'skills', 'vendor', 'otra', 'SKILL.md'), '---\nname: otra\n---\n');
  write(join(repo, '.agents', 'skills', 'sin-skill', 'README.md'), 'no es una skill\n');
  write(join(repo, 'src', 'app.txt'), 'inicio\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'inicio');
  // Lo que no se versiona y se comparte por enlace (en Vetworld, varios GB).
  write(join(repo, 'node_modules', 'paquete', 'keep.txt'), 'no borrar');
  for (const dir of ['.tools', 'workbench', 'assets-source']) write(join(repo, dir, 'keep.txt'), 'no borrar');
  return { base, repo };
}

async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('tiempo agotado esperando la condición');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function brief(id: string, projectId = 'vetworld'): TaskBrief {
  return { id, projectId, title: `Tarea ${id}`, objective: 'prueba', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['pasa'], difficulty: 'low', contextRefs: [], skillRefs: [] };
}

function keepsIntact(repo: string): void {
  expect(readFileSync(join(repo, 'node_modules', 'paquete', 'keep.txt'), 'utf8')).toBe('no borrar');
  for (const dir of ['.tools', 'workbench', 'assets-source']) expect(readFileSync(join(repo, dir, 'keep.txt'), 'utf8'), dir).toBe('no borrar');
}

describe('receta de Vetworld (docs/proyectos)', () => {
  it('el JSON del documento es el mismo que vetworld.json', () => {
    const doc = readFileSync(new URL('vetworld.md', docsDir), 'utf8').replaceAll('\r\n', '\n');
    const block = /```json\n([\s\S]*?)```/.exec(doc)?.[1];
    expect(block, 'el primer bloque json del documento').toBeDefined();
    expect(JSON.parse(block ?? '')).toEqual(recipe);
  });

  it('de punta a punta en un fixture: almacén → worktree con enlaces y skills → gate npm (Node del núcleo) → integrar → quitar sin tocar la copia', async () => {
    const { base, repo } = await vetworldLike();
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    stores.push(store);
    // La receta tal cual; solo cambian las dos rutas de esta máquina por las del fixture.
    store.putProject({ ...recipe, repoPath: repo, workspace: { ...recipe.workspace, worktreesRoot: join(base, 'worktrees') } });
    const log: string[] = [];
    const pw = new ProjectWorktrees({ storeProject: (id) => store.getProject(id), log: (l) => log.push(l) });

    const ws = await pw.create('vetworld', brief('vw-prueba'));
    expect(ws).toEqual({ taskId: 'vw-prueba', path: join(base, 'worktrees', 'vw-prueba'), branch: 'orq/vw-prueba' });
    for (const rel of LINKS) {
      expect(lstatSync(join(ws.path, rel)).isSymbolicLink(), rel).toBe(true);
      expect(realpathSync(join(ws.path, rel)), rel).toBe(realpathSync(join(repo, rel)));
    }
    // postCreate: skills de .agents/skills y .agents/skills/vendor en .claude/skills (las descubre Claude).
    expect(existsSync(join(ws.path, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws.path, '.claude', 'skills', 'otra', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws.path, '.claude', 'skills', 'sin-skill'))).toBe(false);
    // Ni los enlaces ni las skills copiadas aparecen como trabajo del agente.
    expect(git(ws.path, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('');

    write(join(ws.path, 'src', 'nuevo.txt'), 'hecho por el agente\n');
    git(ws.path, 'add', 'src/nuevo.txt');
    git(ws.path, 'commit', '-q', '-m', 'trabajo');
    const result = await pw.integrate('vetworld', ws);
    expect(result.gateSummary).toMatch(/^gate ok \(1 comandos\)\n- npm run -s gate: ok en \d+ ms$/);
    expect(result).toMatchObject({ ok: true, conflicts: [] });
    expect(git(repo, 'show', 'orq/integracion:src/nuevo.txt')).toBe('hecho por el agente\n');

    await pw.remove(ws);
    expect(existsSync(ws.path)).toBe(false);
    keepsIntact(repo); // git worktree remove habría seguido las junctions sin quitarlas antes
    expect(git(repo, 'branch', '--list', 'orq/vw-prueba').trim()).toContain('orq/vw-prueba');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(log).toEqual([]);
  });

  it('un gate que falla no integra y deja la rama de integración donde estaba', async () => {
    const { base, repo } = await vetworldLike();
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    stores.push(store);
    const failing = { command: process.execPath, args: ['-e', "console.error('gate roto'); process.exit(2)"] };
    store.putProject({ ...recipe, repoPath: repo, workspace: { ...recipe.workspace, worktreesRoot: join(base, 'worktrees'), postCreate: [], gate: [failing] } });
    const pw = new ProjectWorktrees({ storeProject: (id) => store.getProject(id) });
    const ws = await pw.create('vetworld', brief('vw-roto'));
    write(join(ws.path, 'src', 'malo.txt'), 'x\n');
    git(ws.path, 'add', 'src/malo.txt');
    git(ws.path, 'commit', '-q', '-m', 'trabajo');
    const before = git(repo, 'rev-parse', 'orq/integracion').trim();
    const result = await pw.integrate('vetworld', ws);
    expect(result.ok).toBe(false);
    expect(result.gateSummary).toMatch(/gate fallido[\s\S]*gate roto/);
    expect(git(repo, 'rev-parse', 'orq/integracion').trim()).toBe(before);
    await pw.remove(ws);
    keepsIntact(repo);
  });
});

describe('sin gate la flota no crea ni integra', () => {
  it('proyecto del almacén sin workspace (alta antigua): create e integrate fallan antes de tocar nada', async () => {
    const base = await tempDir('orq-sin-gate-');
    // repoPath inexistente: aunque fallara la comprobación, git no podría crear nada en C:\dev\.worktrees.
    const record: ProjectRecord = { id: 'sin-gate-c13', name: 'Sin gate', repoPath: join(base, 'no-existe'), createdAt: '2026-11-03T00:00:00.000Z' };
    const log: string[] = [];
    const pw = new ProjectWorktrees({ storeProject: (id) => (id === record.id ? record : undefined), log: (l) => log.push(l) });
    await expect(pw.create(record.id, brief('t1', record.id))).rejects.toThrow(/sin gate configurado.*workspace\.gate/);
    await expect(pw.integrate(record.id, { taskId: 't1', path: join(base, 'wt', 't1'), branch: 'orq/t1' })).rejects.toThrow(/sin gate configurado/);
    expect(existsSync(defaultWorktreesRoot(record.id))).toBe(false);
    expect(log).toEqual(['proyecto sin-gate-c13: sin gate configurado; la flota no creará ni integrará sus tareas hasta configurarlo']);
    // `project()` sigue sirviendo (el paso de commit pide la rama de integración).
    expect(pw.project(record.id).integrationBranch).toBe('orq/integracion');
  });

  it('configuración explícita sin gate (compose): también se rechaza', async () => {
    const base = await tempDir('orq-sin-gate-');
    const pw = new ProjectWorktrees({ projects: [{ id: 'demo', repoPath: join(base, 'repo'), worktreesRoot: join(base, 'wt') }] });
    await expect(pw.create('demo', brief('t1', 'demo'))).rejects.toThrow(/proyecto demo: sin gate configurado/);
    expect(existsSync(join(base, 'wt'))).toBe(false);
  });

  it('reconfigurar con una integración detenida: el worktree anterior se integra y se limpia con su configuración, la tarea nueva usa la nueva', async () => {
    const { base, repo } = await vetworldLike();
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    stores.push(store);
    const started = join(base, 'gate-empezo');
    const open = join(base, 'abrir');
    const barrier = {
      command: process.execPath,
      args: ['-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'');const t0=Date.now();const w=()=>{if(fs.existsSync(${JSON.stringify(open)}))process.exit(0);if(Date.now()-t0>90000)process.exit(9);setTimeout(w,50)};w()`],
    };
    const r1 = join(base, 'wt1');
    const r2 = join(base, 'wt2');
    store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: repo, workspace: { worktreesRoot: r1, links: ['node_modules'], gate: [barrier] } });
    const pw = new ProjectWorktrees({ storeProject: (id) => store.getProject(id) });

    const wsA = await pw.create('vetworld', brief('vw-a'));
    expect(wsA.path).toBe(join(r1, 'vw-a'));
    write(join(wsA.path, 'src', 'a.txt'), 'A\n');
    git(wsA.path, 'add', 'src/a.txt');
    git(wsA.path, 'commit', '-q', '-m', 'a');
    const a = pw.integrate('vetworld', wsA);
    await until(() => existsSync(started));

    // Con la integración de A detenida en su gate, el proyecto se vuelve a registrar con otra raíz, otra rama y otro gate.
    expect(store.deleteProject('vetworld')).toBe(true);
    store.putProject({
      id: 'vetworld',
      name: 'Vetworld',
      repoPath: repo,
      workspace: { worktreesRoot: r2, integrationBranch: 'orq/integracion-2', links: ['node_modules'], gate: [{ command: 'node', args: ['--version'] }] },
    });
    expect(pw.project('vetworld')).toMatchObject({ worktreesRoot: r2, integrationBranch: 'orq/integracion-2' });
    expect(pw.projectOf('vetworld', wsA)).toMatchObject({ worktreesRoot: r1, integrationBranch: 'orq/integracion' });

    const wsB = await pw.create('vetworld', brief('vw-b'));
    expect(wsB.path).toBe(join(r2, 'vw-b'));
    write(join(wsB.path, 'src', 'b.txt'), 'B\n');
    git(wsB.path, 'add', 'src/b.txt');
    git(wsB.path, 'commit', '-q', '-m', 'b');
    let bDone = false;
    const b = pw.integrate('vetworld', wsB).finally(() => { bDone = true; });
    // Mismo repositorio físico: B espera a que A termine aunque su gestor y su configuración sean otros.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(bDone).toBe(false);
    writeFileSync(open, '');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ ok: true });
    expect(ra.gateSummary).toMatch(/^gate ok \(1 comandos\)/);
    expect(rb).toMatchObject({ ok: true });
    expect(rb.gateSummary).toMatch(/--version: ok/);
    // Cada una en la rama de su configuración.
    expect(git(repo, 'show', 'orq/integracion:src/a.txt')).toBe('A\n');
    expect(git(repo, 'show', 'orq/integracion-2:src/b.txt')).toBe('B\n');
    await expect(pw.integrate('otro', wsB)).rejects.toThrow(/es del proyecto vetworld/);

    // Cada worktree se limpia con su gestor de origen (A con la raíz vieja, B con la nueva).
    await pw.remove(wsA);
    await pw.remove(wsB);
    expect(existsSync(wsA.path)).toBe(false);
    expect(existsSync(wsB.path)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toMatch(/vw-a|vw-b/);
    keepsIntact(repo);
  });
});

describe('raíces de configuraciones retiradas y de otros proyectos (2.ª revisión, punto 5)', () => {
  it('una configuración nueva no puede usar una raíz que se solape con la retirada que aún tiene worktrees, ni con la de otro proyecto', async () => {
    const { base, repo } = await vetworldLike();
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    stores.push(store);
    const gate = [{ command: 'node', args: ['--version'] }];
    const r1 = join(base, 'wt1');
    store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: repo, workspace: { worktreesRoot: r1, gate } });
    const otroRepo = join(base, 'otro-repo');
    mkdirSync(otroRepo);
    const pw = new ProjectWorktrees({
      // Un proyecto explícito (compose) que el almacén no ve.
      projects: [{ id: 'otro', repoPath: otroRepo, worktreesRoot: join(base, 'wt-otro'), gate }],
      storeProject: (id) => store.getProject(id),
    });
    const wsA = await pw.create('vetworld', brief('vw-a'));

    // Raíz nueva dentro de la retirada (que aún tiene vw-a): rechazada.
    store.deleteProject('vetworld');
    store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: repo, workspace: { worktreesRoot: join(r1, 'nueva'), gate } });
    await expect(pw.create('vetworld', brief('vw-b'))).rejects.toThrow(/se solapa con la anterior .* aún tiene worktrees/);
    // Raíz nueva dentro de la del proyecto explícito: rechazada (el almacén no lo sabría).
    store.deleteProject('vetworld');
    store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: repo, workspace: { worktreesRoot: join(base, 'wt-otro', 'vw'), gate } });
    await expect(pw.create('vetworld', brief('vw-b'))).rejects.toThrow(/se solapan con las del proyecto otro/);
    // Volver exactamente a la raíz anterior sí vale, y una raíz aparte también.
    store.deleteProject('vetworld');
    store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: repo, workspace: { worktreesRoot: r1, gate: [{ command: 'node', args: ['-v'] }] } });
    const wsB = await pw.create('vetworld', brief('vw-b'));
    expect(wsB.path).toBe(join(r1, 'vw-b'));
    await pw.remove(wsA);
    await pw.remove(wsB);
    keepsIntact(repo);
  });

  it('una raíz retirada que solo conserva `_integracion` sigue protegida (también por alias físico) hasta que se quita', async () => {
    const { base, repo } = await vetworldLike();
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    stores.push(store);
    const gate = [{ command: 'node', args: ['--version'] }];
    const reconfigure = (worktreesRoot: string) => {
      store.deleteProject('vetworld');
      store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: repo, workspace: { worktreesRoot, gate } });
    };
    const r1 = join(base, 'wt1');
    reconfigure(r1);
    const pw = new ProjectWorktrees({ storeProject: (id) => store.getProject(id) });
    const wsA = await pw.create('vetworld', brief('vw-a'));
    write(join(wsA.path, 'src', 'a.txt'), 'A\n');
    git(wsA.path, 'add', 'src/a.txt');
    git(wsA.path, 'commit', '-q', '-m', 'a');
    expect(await pw.integrate('vetworld', wsA)).toMatchObject({ ok: true });
    await pw.remove(wsA); // la tarea ya no está ligada; queda R1\_integracion
    expect(existsSync(join(r1, '_integracion'))).toBe(true);

    // Otra raíz aparte: vale, y la de R1 queda retirada pero protegida.
    reconfigure(join(base, 'wt2'));
    const wsB = await pw.create('vetworld', brief('vw-b'));
    await pw.remove(wsB);
    reconfigure(join(r1, 'nueva'));
    await expect(pw.create('vetworld', brief('vw-c'))).rejects.toThrow(/se solapa con la anterior .*wt1.* aún tiene worktrees/);
    // Un alias por junction que físicamente cae dentro de R1, también.
    symlinkSync(r1, join(base, 'alias'), 'junction');
    reconfigure(join(base, 'alias', 'otra'));
    await expect(pw.create('vetworld', brief('vw-c'))).rejects.toThrow(/se solapa con la anterior/);

    // Al quitar `_integracion` (sin enlaces en esta configuración), la raíz retirada deja de contar.
    git(repo, 'worktree', 'remove', join(r1, '_integracion'));
    reconfigure(join(r1, 'nueva'));
    const wsC = await pw.create('vetworld', brief('vw-c'));
    expect(wsC.path).toBe(join(r1, 'nueva', 'vw-c'));
    await pw.remove(wsC);
    keepsIntact(repo);
  });

  it('transición directa, sin pasar por otra raíz: R1 con `_integracion` → R1\\nueva y → alias físico dentro de R1, rechazadas', async () => {
    const { base, repo } = await vetworldLike();
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    stores.push(store);
    const gate = [{ command: 'node', args: ['--version'] }];
    const reconfigure = (worktreesRoot: string) => {
      store.deleteProject('vetworld');
      store.putProject({ id: 'vetworld', name: 'Vetworld', repoPath: repo, workspace: { worktreesRoot, gate } });
    };
    const r1 = join(base, 'wt1');
    reconfigure(r1);
    const pw = new ProjectWorktrees({ storeProject: (id) => store.getProject(id) });
    const wsA = await pw.create('vetworld', brief('vw-a'));
    write(join(wsA.path, 'src', 'a.txt'), 'A\n');
    git(wsA.path, 'add', 'src/a.txt');
    git(wsA.path, 'commit', '-q', '-m', 'a');
    expect(await pw.integrate('vetworld', wsA)).toMatchObject({ ok: true });
    await pw.remove(wsA);
    expect(existsSync(join(r1, '_integracion'))).toBe(true);

    reconfigure(join(r1, 'nueva'));
    await expect(pw.create('vetworld', brief('vw-b'))).rejects.toThrow(/se solapa con la anterior .*wt1.* aún tiene worktrees/);
    symlinkSync(r1, join(base, 'alias'), 'junction');
    reconfigure(join(base, 'alias', 'otra'));
    await expect(pw.create('vetworld', brief('vw-b'))).rejects.toThrow(/se solapa con la anterior/);
    // La configuración vigente sigue siendo R1: volver a ella exactamente funciona.
    reconfigure(r1);
    const wsB = await pw.create('vetworld', brief('vw-b'));
    expect(wsB.path).toBe(join(r1, 'vw-b'));
    await pw.remove(wsB);
    keepsIntact(repo);
  });
});
