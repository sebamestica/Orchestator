import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.ts';

type Json = Record<string, unknown>;

/** Receta real de Vetworld (docs/proyectos/vetworld.json): el mismo cuerpo que se envía a POST /projects. */
const vetworld = JSON.parse(readFileSync(new URL('../../../docs/proyectos/vetworld.json', import.meta.url), 'utf8')) as Json;

describe('POST /projects con workspace', () => {
  it('acepta la receta de Vetworld, la guarda y la devuelve con los valores por defecto', async () => {
    const t = makeTestApp();
    const res = await t.req('POST', '/projects', { body: vetworld });
    expect(res.status).toBe(201);
    const project = res.json.project as Json & { workspace: Json & { gate: Json[]; postCreate: Json[] } };
    expect(project).toMatchObject({ id: 'vetworld', repoPath: 'C:\\dev\\Vetworld' });
    expect(project.workspace).toMatchObject({
      worktreesRoot: 'C:\\dev\\.worktrees\\vetworld-orq',
      links: ['.tools', 'workbench', 'assets-source', 'node_modules'],
      gate: [{ command: 'npm', args: ['run', '-s', 'gate'], timeoutMs: 1_800_000, env: {} }],
    });
    expect(project.workspace.postCreate).toHaveLength(1);
    expect((await t.req('GET', '/projects/vetworld')).json.project).toEqual(project);
    expect((await t.req('GET', '/projects')).json.projects).toEqual([project]);
    // Lo que usa la flota sale del almacén, no de la respuesta.
    expect(t.store.getProject('vetworld')?.workspace?.gate[0]?.command).toBe('npm');
  });

  it('sin workspace responde igual que antes', async () => {
    const t = makeTestApp();
    const res = await t.req('POST', '/projects', { body: { id: 'p1', name: 'P', repoPath: 'C:\\dev\\p' } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.json.project as Json).sort()).toEqual(['createdAt', 'id', 'name', 'repoPath']);
  });

  it('400 con el motivo ante un workspace no válido, y no guarda nada', async () => {
    const t = makeTestApp();
    const ws = vetworld.workspace as Json;
    const cases: [Json, RegExp][] = [
      [{ ...ws, gate: [] }, /gate es obligatorio/],
      [{ links: ['node_modules'] }, /workspace\.gate/],
      [{ ...ws, links: ['..\\Vetworld-otro'] }, /ruta relativa sin «\.\.»/],
      [{ ...ws, worktreesRoot: 'C:\\dev\\Vetworld\\.worktrees' }, /no puede estar dentro de la copia del usuario/],
      [{ ...ws, integrationBranch: 'main' }, /rama base/],
      [{ ...ws, worktreeRoot: 'C:\\dev\\x' }, /worktreeRoot/],
      // Por REST no se elige dónde se escribe el pre-push (pisaría .git/hooks de la copia del usuario).
      [{ ...ws, hooksDir: 'C:\\dev\\Vetworld\\.git\\hooks' }, /hooksDir/],
      [{ ...ws, gate: [{ command: 'npm.cmd', args: ['run', '-s', 'gate'], timeoutMs: 0 }] }, /workspace\.gate\.0\.timeoutMs/],
      // Revisión de Codex (H1 y H2): programa sin ruta relativa, env sin variables de carga, raíz propia.
      [{ ...ws, gate: [{ command: 'scripts\\gate.cmd' }] }, /nunca relativa/],
      [{ ...ws, gate: [{ command: 'npm.cmd', args: ['run', 'gate'], env: { NODE_OPTIONS: '--require ./x.js' } }] }, /NODE_OPTIONS/],
      [{ ...ws, postCreate: [{ command: 'node', env: { Path: 'C:\\malo' } }] }, /env no puede cambiar PATH/],
      [{ ...ws, worktreesRoot: 'worktrees\\vw' }, /ruta absoluta/],
      [{ ...ws, worktreesRoot: 'C:\\' }, /raíz de un volumen/],
      [{ ...ws, worktreesRoot: 'C:\\Windows\\Temp\\vw' }, /carpeta del sistema/],
      [{ ...ws, worktreesRoot: 'C:\\dev' }, /no puede contener la copia del usuario/],
    ];
    for (const [workspace, message] of cases) {
      const res = await t.req('POST', '/projects', { body: { ...vetworld, workspace } });
      expect(res.status, JSON.stringify(workspace)).toBe(400);
      expect(JSON.stringify(res.json), JSON.stringify(workspace)).toMatch(message);
    }
    expect(t.store.listProjects()).toEqual([]);
  });

  it('rechaza un segundo proyecto de la flota que comparta copia o raíz con otro; uno sin workspace sigue como antes', async () => {
    const t = makeTestApp();
    expect((await t.req('POST', '/projects', { body: vetworld })).status).toBe(201);
    const ws = vetworld.workspace as Json;
    const copia = await t.req('POST', '/projects', { body: { ...vetworld, id: 'vetworld-2', workspace: { ...ws, worktreesRoot: 'C:\\dev\\.worktrees\\vw2' } } });
    expect(copia.status).toBe(400);
    expect(JSON.stringify(copia.json)).toMatch(/se solapan con las del proyecto vetworld/);
    const raiz = await t.req('POST', '/projects', { body: { id: 'otro', name: 'Otro', repoPath: 'C:\\dev\\Otro', workspace: { ...ws, worktreesRoot: 'C:\\dev\\.worktrees\\vetworld-orq\\otro' } } });
    expect(raiz.status).toBe(400);
    expect((await t.req('POST', '/projects', { body: { id: 'legado', name: 'Legado', repoPath: 'C:\\dev\\Vetworld' } })).status).toBe(201);
  });

  it('DELETE responde 409 con tareas activas (no se reconfigura a mitad de una integración) y borra cuando terminan', async () => {
    const t = makeTestApp();
    expect((await t.req('POST', '/projects', { body: vetworld })).status).toBe(201);
    const task = { id: 'vw-uno', projectId: 'vetworld', title: 'Uno', objective: 'x', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['ok'], difficulty: 'low' };
    expect((await t.req('POST', '/tasks', { body: task })).status).toBe(201);
    // Pendiente (sin aprobar) no cuenta como activa.
    expect((await t.req('POST', '/tasks', { body: { ...task, id: 'vw-dos' } })).status).toBe(201);
    for (const state of ['ready', 'running', 'review', 'handed_off'] as const) {
      t.store.setTaskState('vw-uno', state);
      const res = await t.req('DELETE', '/projects/vetworld');
      expect(res.status, state).toBe(409);
      expect(JSON.stringify(res.json)).toMatch(/1 tarea\(s\) activa\(s\) \(vw-uno\)/);
    }
    t.store.setTaskState('vw-uno', 'integrated');
    expect((await t.req('DELETE', '/projects/vetworld')).status).toBe(200);
  });
});
