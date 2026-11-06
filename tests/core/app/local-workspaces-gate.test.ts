import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalWorkspaces, type LocalProject } from '../../../src/core/app/local-workspaces.ts';
import { taskBriefSchema, type TaskBrief, type Workspace } from '../../../src/shared/index.ts';
import { cleanupDirs, tempDir } from '../../integration/helpers.ts';

afterEach(async () => {
  await cleanupDirs();
});

function task(id: string): TaskBrief {
  return taskBriefSchema.parse({ id, projectId: 'local-demo', title: `Tarea ${id}`, objective: 'x', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['y'], difficulty: 'low' });
}

/**
 * Carpeta local con un gate que cuenta sus corridas: el script y el contador viven **fuera** de la carpeta (el gate
 * no se busca dentro de ella). El gate falla si `estado.txt` dice «roto».
 */
async function setup() {
  const root = await tempDir('orq-local-gate-');
  const folder = join(root, 'proyecto');
  const tools = join(root, 'herramientas');
  mkdirSync(join(folder, 'src'), { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(folder, 'estado.txt'), 'bien\n');
  writeFileSync(join(folder, 'package.json'), '{"name":"demo","private":true}\n');
  const counter = join(tools, 'corridas.txt');
  const script = join(tools, 'contar.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(counter)}, 'x\\n');\nif (readFileSync('estado.txt', 'utf8').includes('roto')) { console.error('gate roto'); process.exit(1); }\n`,
  );
  const lw = new LocalWorkspaces({ gateFor: async () => [{ command: process.execPath, args: [script], timeoutMs: 60_000, env: {} }] });
  const project: LocalProject = { id: 'local-demo', repoPath: folder };
  const runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
  return { folder, lw, project, runs };
}

async function verified(s: Awaited<ReturnType<typeof setup>>, id = 't1'): Promise<Workspace> {
  const w = await s.lw.create(s.project, task(id));
  expect(await s.lw.verify(s.project, w)).toMatchObject({ ok: true });
  return w;
}

describe('LocalWorkspaces: el gate no se repite al integrar si la carpeta no cambió', () => {
  it('verify (ok) → integrate: una sola corrida, integrate ok y lo dice (lo que se escribe en .orq/ no cuenta)', async () => {
    const s = await setup();
    const w = await verified(s);
    // Antes de revisar la flota reescribe BRIEF y PLAN, y el revisor deja su informe: todo en `.orq/`.
    writeFileSync(join(s.folder, '.orq', 'BRIEF.md'), '# encargo de revisión\n');
    writeFileSync(join(s.folder, '.orq', 'REVISION.md'), 'aprobado\n');
    const result = await s.lw.integrate(s.project, w);
    expect(s.runs()).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.gateSummary).toMatch(/^local: gate ok/);
    expect(result.gateSummary).toContain('ya verificado antes de revisar');
  }, 60_000);

  it('si cambia un archivo de la carpeta tras verify (p. ej. un revisor por Bash), integrate vuelve a correr el gate', async () => {
    const s = await setup();
    const w = await verified(s);
    appendFileSync(join(s.folder, 'README.md'), 'cambio del revisor\n');
    const result = await s.lw.integrate(s.project, w);
    expect(s.runs()).toBe(2);
    expect(result.gateSummary).not.toContain('ya verificado');
  }, 60_000);

  it('si cambia package.json (de donde sale el gate), integrate vuelve a correrlo', async () => {
    const s = await setup();
    const w = await verified(s);
    writeFileSync(join(s.folder, 'package.json'), '{"name":"demo","private":true,"scripts":{"check":"node x"}}\n');
    await s.lw.integrate(s.project, w);
    expect(s.runs()).toBe(2);
  }, 60_000);

  it('integrate sin verify antes corre el gate', async () => {
    const s = await setup();
    const w = await s.lw.create(s.project, task('t1'));
    expect((await s.lw.integrate(s.project, w)).ok).toBe(true);
    expect(s.runs()).toBe(1);
  }, 60_000);

  it('verify nunca usa la caché; tras un verify fallido, integrate corre el gate', async () => {
    const s = await setup();
    const w = await verified(s);
    expect(await s.lw.verify(s.project, w)).toMatchObject({ ok: true });
    expect(s.runs()).toBe(2);
    writeFileSync(join(s.folder, 'estado.txt'), 'roto\n');
    expect(await s.lw.verify(s.project, w)).toMatchObject({ ok: false });
    writeFileSync(join(s.folder, 'estado.txt'), 'bien\n');
    expect((await s.lw.integrate(s.project, w)).ok).toBe(true);
    expect(s.runs()).toBe(4);
  }, 60_000);

  it('la caché no pasa de una tarea a otra: verify → remove → create → integrate corre el gate', async () => {
    const s = await setup();
    const w = await verified(s);
    await s.lw.remove(w);
    const w2 = await s.lw.create(s.project, task('t2'));
    await s.lw.integrate(s.project, w2);
    expect(s.runs()).toBe(2);
  }, 60_000);

  it('el mismo id que vuelve a crearse (reintento) tampoco hereda la caché', async () => {
    const s = await setup();
    await verified(s);
    const again = await s.lw.create(s.project, task('t1'));
    await s.lw.integrate(s.project, again);
    expect(s.runs()).toBe(2);
  }, 60_000);
});
