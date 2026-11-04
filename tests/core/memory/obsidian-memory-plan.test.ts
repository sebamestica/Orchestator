import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNote } from '../../../src/core/memory/frontmatter.ts';
import { ObsidianMemory, type PlanNoteInput, type SessionNoteInput } from '../../../src/core/memory/obsidian-memory.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

const worker = path.resolve(import.meta.dirname, 'datos', 'plan-worker.ts');
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const PLAN_ID = 'plan-20261104-a1b2c3';
const NOTE = `Orquestador/Proyectos/orquestador/Planes/${PLAN_ID}`;

let vault: string;
beforeEach(async () => { vault = await mkdtemp(path.join(os.tmpdir(), 'orq-planes-')); });
afterEach(async () => { await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function plan(over: Partial<PlanNoteInput> = {}): PlanNoteInput {
  return {
    projectId: 'orquestador',
    planId: PLAN_ID,
    title: `Plan ${PLAN_ID}`,
    text: '# Plan general plan-20261104-a1b2c3\n\n## Plan\n1. Servidor de la interfaz.\n2. Chat con la mente.\n\n## Tareas del plan\n- `c14-servidor-ui` — Servidor\n- `c15-chat` — Chat',
    taskIds: ['c14-servidor-ui'],
    at: '2026-11-04T10:00:00Z',
    ...over,
  };
}

function session(k: number, over: Partial<SessionNoteInput> = {}): SessionNoteInput {
  return {
    projectId: 'orquestador', taskId: `c1${k}-tarea`, agentId: 'claude-1', title: `Sesión ${k} del servidor`, outcome: 'ok',
    summary: `Resumen de la sesión ${k}: rutas del servidor y pruebas.`, filesChanged: [`src/core/server/m${k}.ts`],
    inputTokens: 1_000 + k, outputTokens: 50 + k, costUsd: 0.01, at: `2026-11-04T1${k}:00:00Z`, ...over,
  };
}

const read = async (note: string) => readFile(path.join(vault, `${note}.md`), 'utf8');

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(full)));
    else out.push(path.relative(vault, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

describe('ObsidianMemory.recordPlan', () => {
  it('crea Proyectos/<proyecto>/Planes/<id>.md con frontmatter válido, enlace al proyecto y el texto del plan', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const note = await memory.recordPlan(plan({ taskIds: ['c14-servidor-ui', 'c15-chat'] }));
    expect(note).toBe(NOTE);
    expect(memory.planNote('orquestador', PLAN_ID)).toBe(NOTE);
    const parsed = parseNote(await read(note)); // modo estricto
    expect(parsed.data).toEqual({
      tipo: 'plan', proyecto: 'orquestador', plan: PLAN_ID, fecha: '2026-11-04', at: '2026-11-04T10:00:00Z', actualizado: '2026-11-04',
      titulo: `Plan ${PLAN_ID}`, tareas: ['c14-servidor-ui', 'c15-chat'], tags: ['orquestador/plan', 'proyecto/orquestador'],
    });
    expect(parsed.body).toContain(`# Plan ${PLAN_ID}`);
    expect(parsed.body).toContain('- Proyecto: [[Orquestador/Proyectos/orquestador/Contexto|orquestador]]');
    expect(parsed.body).toContain('- Tareas: `c14-servidor-ui`, `c15-chat`');
    // El texto va dentro de «## Plan», con sus encabezados bajados para no romper la estructura de la nota.
    expect(parsed.body).toContain('## Plan\n### Plan general plan-20261104-a1b2c3');
    expect(parsed.body).toContain('### Tareas del plan\n- `c14-servidor-ui` — Servidor');
    expect(parsed.body.match(/^## /gm)).toHaveLength(1);
  });

  it('es idempotente: otra tarea del mismo plan solo suma su id y se conserva lo editado a mano', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.recordPlan(plan());
    const file = path.join(vault, `${NOTE}.md`);
    await writeFile(file, (await readFile(file, 'utf8')).replace('## Plan', '## Notas del usuario\nRevisar el orden.\n\n## Plan').replace('tags:', 'cssclasses: [ancho]\ntags:'));
    await memory.recordPlan(plan({ taskIds: ['c15-chat'], at: '2026-11-05T09:00:00Z', text: 'otro texto que no reemplaza al original' }));
    await memory.recordPlan(plan({ taskIds: ['c15-chat', 'c14-servidor-ui'], at: '2026-11-03T09:00:00Z' }));
    const parsed = parseNote(await readFile(file, 'utf8'));
    expect(parsed.data).toMatchObject({ tareas: ['c14-servidor-ui', 'c15-chat'], actualizado: '2026-11-05', fecha: '2026-11-04', cssclasses: ['ancho'] });
    expect(parsed.body).toContain('## Notas del usuario\nRevisar el orden.');
    expect(parsed.body).toContain('- Tareas: `c14-servidor-ui`, `c15-chat`');
    expect(parsed.body).not.toContain('otro texto');
    expect(await readdir(path.join(vault, 'Orquestador', 'Proyectos', 'orquestador', 'Planes'))).toEqual([`${PLAN_ID}.md`]);
  });

  it('tacha secretos del título y del texto', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault, extraSecrets: ['secreto-del-usuario-123'] });
    await memory.recordPlan(plan({
      title: 'Plan con sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
      text: 'Usa ANTHROPIC_API_KEY=sk-ant-api03-BBBBBBBBBBBBBBBBBBBB y secreto-del-usuario-123.\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    }));
    const text = await read(NOTE);
    expect(text).not.toMatch(/sk-ant-api03|secreto-del-usuario|abcdefghijklmnop/);
    expect(text).toContain('[REDACTADO]');
  });

  it('valida la entrada y no escribe con ids que intenten salir de la bóveda', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    for (const bad of [{ planId: '../fuera' }, { projectId: 'C:/Windows' }, { taskIds: ['..\\x'] }, { taskIds: [] }, { at: 'ayer' }, { text: '' }]) {
      await expect(memory.recordPlan(plan(bad))).rejects.toThrow();
    }
    expect(await readdir(vault)).toEqual([]);
  });

  it('escrituras concurrentes en el mismo proceso: una nota con todas las tareas', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const ids = Array.from({ length: 10 }, (_, k) => `tarea-${k}`);
    await Promise.all(ids.map((id) => memory.recordPlan(plan({ taskIds: [id] }))));
    const data = parseNote(await read(NOTE)).data;
    expect([...(data.tareas as string[])].sort()).toEqual([...ids].sort());
  });

  it('6 procesos reales a la vez sobre el mismo plan: una sola nota con las 12 tareas y sin restos', async () => {
    const startAt = Date.now() + 2500;
    const runs = Array.from({ length: 6 }, (_, w) => [plan({ taskIds: [`w${w}-a`] }), plan({ taskIds: [`w${w}-b`] })]);
    const results = await Promise.all(runs.map((plans) => new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(plans), 'utf8').toString('base64');
      const child = spawn(process.execPath, [worker, vault, payload, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    })));
    for (const r of results) expect(r, r.out).toMatchObject({ code: 0 });
    const data = parseNote(await read(NOTE)).data;
    expect([...(data.tareas as string[])].sort()).toEqual(runs.flat().flatMap((p) => p.taskIds).sort());
    expect(await allFiles(vault)).toEqual([`${NOTE}.md`]); // ni temporales ni candado
    expect(existsSync(path.join(vault, '.orquestador-candado'))).toBe(false);
  }, 60_000);
});

describe('ObsidianMemory.recordSession con plan', () => {
  it('la sesión enlaza la nota de su plan (el enlace resuelve) y anota los pasos hechos y pendientes', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.recordPlan(plan());
    await memory.recordSession(session(1, { plan: { id: PLAN_ID, exists: true, done: 3, pending: 2 } }));
    const file = (await memory.listSessions('orquestador'))[0]?.notePath ?? '';
    const parsed = parseNote(await readFile(path.join(vault, file), 'utf8'));
    expect(parsed.data).toMatchObject({ tipo: 'sesion', plan: PLAN_ID, plan_tarea: true, plan_pasos_hechos: 3, plan_pasos_pendientes: 2 });
    expect(parsed.body).toContain(`- Plan: [[${NOTE}|${PLAN_ID}]] · Pasos de \`.orq/PLAN-TAREA.md\`: 3 hechos, 2 pendientes`);
    for (const m of parsed.body.matchAll(WIKILINK)) expect(existsSync(path.join(vault, `${m[1] ?? ''}.md`)), `[[${m[1] ?? ''}]]`).toBe(true);
  });

  it('sin PLAN-TAREA.md lo dice; sin plan, la nota queda como antes', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.recordSession(session(1, { plan: { exists: false, done: 0, pending: 0 } }));
    await memory.recordSession(session(2));
    const [withPlan, without] = await memory.listSessions('orquestador');
    const a = parseNote(await readFile(path.join(vault, withPlan?.notePath ?? ''), 'utf8'));
    expect(a.data).toMatchObject({ plan_tarea: false });
    expect(a.data.plan).toBeUndefined();
    expect(a.body).toContain('- sin `.orq/PLAN-TAREA.md`');
    const b = parseNote(await readFile(path.join(vault, without?.notePath ?? ''), 'utf8'));
    expect(Object.keys(b.data).filter((k) => k.startsWith('plan'))).toEqual([]);
    expect(b.body).not.toContain('Plan');
    await expect(memory.recordSession(session(3, { plan: { id: '../fuera' } }))).rejects.toThrow();
  });

  it('buildContext no crece: el mismo contexto con o sin planes y datos del plan en las sesiones', async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), 'orq-planes-sin-'));
    try {
      const withPlans = new ObsidianMemory({ vaultPath: vault });
      const plain = new ObsidianMemory({ vaultPath: other });
      await withPlans.recordPlan(plan({ taskIds: ['c11-tarea', 'c12-tarea', 'c13-tarea'] }));
      for (const k of [1, 2, 3]) {
        await withPlans.recordSession(session(k, { plan: { id: PLAN_ID, exists: true, done: k, pending: 3 - k } }));
        await plain.recordSession(session(k));
      }
      const t = taskBriefSchema.parse({
        id: 'c14-servidor-ui', projectId: 'orquestador', title: 'Servidor de la interfaz', objective: 'x',
        ownedPaths: ['src/core/server/**'], dependsOn: [], acceptance: ['y'], difficulty: 'medium',
      });
      for (const budget of [300, 1_000, 4_000]) {
        const context = await withPlans.buildContext('orquestador', t, budget);
        expect(context).toBe(await plain.buildContext('orquestador', t, budget));
        expect(context).not.toContain('Planes/');
        expect(context).not.toContain('Chat con la mente');
      }
      expect(await withPlans.buildContext('orquestador', t, 4_000)).toContain('c11-tarea');
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
