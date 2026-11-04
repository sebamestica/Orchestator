// Revisión de seguridad y concurrencia de agy (2026-11-01, .orq/INFORME.md de agy-revision), hallazgos de memoria.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNote } from '../../../src/core/memory/frontmatter.ts';
import { ObsidianMemory } from '../../../src/core/memory/obsidian-memory.ts';
import { VaultLockBusyError } from '../../../src/core/memory/vault-lock.ts';
import type { SessionSummary } from '../../../src/shared/index.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

const worker = path.resolve(import.meta.dirname, 'datos', 'record-worker.ts');

let vault: string;
beforeEach(async () => { vault = await mkdtemp(path.join(os.tmpdir(), 'orq-revision-')); });
afterEach(async () => { await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function session(k: number, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    projectId: 'orquestador', taskId: `tarea-${k}`, agentId: 'claude-1', title: `Sesión ${k}`, outcome: 'ok',
    summary: `Resumen de la sesión ${k}.`, filesChanged: [`src/core/m${k}.ts`],
    inputTokens: 22_572 + k, outputTokens: 5 + k, costUsd: 0.103, at: `2026-11-01T12:00:0${k}Z`, ...over,
  };
}

function runWorker(sessions: SessionSummary[], startAt: number): Promise<{ code: number | null; out: string }> {
  const payload = Buffer.from(JSON.stringify(sessions), 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, vault, payload, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const projectFile = () => path.join(vault, 'Orquestador', 'Proyectos', 'orquestador', 'Contexto.md');
const agentFile = () => path.join(vault, 'Orquestador', 'Agentes', 'claude-1.md');

describe('revisión agy, hallazgo 1 (crítica): recordSession entre procesos', () => {
  it('8 procesos reales a la vez: 8/8 sesiones, bitácora completa y totales exactos', async () => {
    // Cuatro sesiones de la misma tarea el mismo día (compiten por el nombre de la nota) y cuatro de tareas distintas.
    const sessions = Array.from({ length: 8 }, (_, k) => session(k, k < 4 ? { taskId: 'c2-orquestacion' } : {}));
    const startAt = Date.now() + 2500;
    const results = await Promise.all(sessions.map((s) => runWorker([s], startAt)));
    for (const r of results) expect(r, r.out).toMatchObject({ code: 0 });

    const notes = (await readdir(path.join(vault, 'Orquestador', 'Sesiones'))).filter((n) => n.endsWith('.md')).sort();
    expect(notes).toEqual([
      '2026-11-01-c2-orquestacion-2.md', '2026-11-01-c2-orquestacion-3.md', '2026-11-01-c2-orquestacion-4.md', '2026-11-01-c2-orquestacion.md',
      '2026-11-01-tarea-4.md', '2026-11-01-tarea-5.md', '2026-11-01-tarea-6.md', '2026-11-01-tarea-7.md',
    ]);
    const ats = new Set<string>();
    for (const name of notes) ats.add(String(parseNote(await readFile(path.join(vault, 'Orquestador', 'Sesiones', name), 'utf8')).data.at));
    expect(ats.size).toBe(8);

    const project = parseNote(await readFile(projectFile(), 'utf8'));
    expect(project.data.sesiones).toBe(8);
    expect(project.body.split('\n').filter((l) => l.startsWith('- 2026-11-01 · [[Orquestador/Sesiones/'))).toHaveLength(8);

    const agent = parseNote(await readFile(agentFile(), 'utf8'));
    expect(agent.data).toMatchObject({
      sesiones: 8,
      tokens_entrada: sessions.reduce((n, s) => n + s.inputTokens, 0),
      tokens_salida: sessions.reduce((n, s) => n + s.outputTokens, 0),
      costo_usd: 0.824,
    });
    expect(agent.body.split('\n').filter((l) => l.startsWith('- 2026-11-01 · '))).toHaveLength(8);
    // No quedan candados (ni restos de candados rotos) ni temporales.
    expect(await readdir(vault)).toEqual(['Orquestador']);
    expect((await readdir(path.join(vault, 'Orquestador'))).sort()).toEqual(['Agentes', 'Decisiones', 'Proyectos', 'Sesiones']);
  }, 60_000);
});

describe('revisión agy, hallazgo 1: candado abandonado', () => {
  it('un candado de un proceso muerto en este equipo no bloquea la memoria', async () => {
    const lock = path.join(vault, '.orquestador-candado');
    await mkdir(lock, { recursive: true });
    // PID que no existe (los de Windows son múltiplos de 4 y no llegan tan alto en este equipo).
    await writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: 4_194_302, host: os.hostname(), at: new Date().toISOString(), token: 'muerto' }));
    const memory = new ObsidianMemory({ vaultPath: vault, lock: { timeoutMs: 5000 } });
    await memory.recordSession(session(1));
    expect(parseNote(await readFile(agentFile(), 'utf8')).data.sesiones).toBe(1);
    expect((await readdir(vault)).filter((n) => n.startsWith('.orquestador-candado'))).toEqual([]);
  });

  it('un candado vivo hace esperar y, si no se libera, falla sin escribir nada', async () => {
    const lock = path.join(vault, '.orquestador-candado');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token: 'vivo' }));
    const memory = new ObsidianMemory({ vaultPath: vault, lock: { timeoutMs: 300 } });
    await expect(memory.recordSession(session(1))).rejects.toThrow(VaultLockBusyError);
    expect((await readdir(vault)).sort()).toEqual(['.orquestador-candado']);
  });
});

describe('revisión agy, hallazgo 2 (baja): encabezados ## dentro de textos recibidos', () => {
  it('un resumen con «## Bitácora» o «## Resumen» no rompe las secciones', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.recordSession(session(1, { summary: 'Hecho.\n## Archivos\nfalso\n# Título falso\nsigue el resumen' }));
    await memory.writeProjectSummary('orquestador', 'Progreso actual:\n## Bitácora\nSe completó la fase 1.\n  ## Resumen\nfin del resumen', '2026-11-01T13:00:00Z');
    await memory.recordSession(session(2));

    const text = await readFile(projectFile(), 'utf8');
    const lines = text.split('\n');
    expect(lines.filter((l) => l === '## Bitácora')).toHaveLength(1);
    expect(lines.filter((l) => l.trim() === '## Resumen')).toHaveLength(1);
    // Las dos líneas de la bitácora van bajo la bitácora real, al final.
    const log = lines.slice(lines.indexOf('## Bitácora') + 1).filter((l) => l.startsWith('- '));
    expect(log).toHaveLength(2);

    const summary = await memory.projectSummary('orquestador');
    expect(summary).toContain('Se completó la fase 1.');
    expect(summary).toContain('fin del resumen');
    expect(summary).not.toContain('[[Orquestador/Sesiones/');

    const [first] = await memory.listSessions('orquestador');
    expect(first?.summary).toContain('sigue el resumen');
    const context = await memory.buildContext('orquestador', taskBriefSchema.parse({
      id: 'tarea-1', projectId: 'orquestador', title: 'x', objective: 'x', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['x'], difficulty: 'low',
    }), 5000);
    expect(context).toContain('sigue el resumen');
  });

  it('respeta los bloques de código: no toca un «# comentario» dentro de ```', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.writeProjectSummary('orquestador', 'Arranque:\n```bash\n# comentario\n## no es sección\nnpm run check\n```\nlisto', '2026-11-01T13:00:00Z');
    await memory.recordSession(session(1));
    const summary = await memory.projectSummary('orquestador');
    expect(summary).toContain('```bash\n# comentario\n## no es sección\nnpm run check\n```\nlisto');
    expect(summary).not.toContain('[[Orquestador/Sesiones/');
  });
});

describe('revisión agy, hallazgo 3 (baja): Contexto.md editado a mano con YAML que no entendemos', () => {
  it('recordSession y writeProjectSummary siguen funcionando y conservan las propiedades del usuario', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.recordSession(session(1));
    const userLines = ['tags: [repetida]', 'metadata: {"origen": {"app": "obsidian"}}', 'raro:valor', '\tcon-tab: 1'];
    const original = await readFile(projectFile(), 'utf8');
    await writeFile(projectFile(), original.replace('\n---\n', `\n${userLines.join('\n')}\n---\n`));

    await memory.recordSession(session(2));
    await memory.writeProjectSummary('orquestador', 'Resumen nuevo.', '2026-11-02T00:00:00Z');
    await memory.recordSession(session(3));

    const after = await readFile(projectFile(), 'utf8');
    for (const line of userLines) expect(after).toContain(`\n${line}\n`);
    const data = parseNote(after, { lenient: true, skipBadLines: true }).data;
    expect(data).toMatchObject({ sesiones: 3, actualizado: '2026-11-02' });
    expect(after.split('\n').filter((l) => l.startsWith('- 2026-11-01 · [['))).toHaveLength(3);
    expect(await memory.projectSummary('orquestador')).toBe('Resumen nuevo.');
  });

  it('la nota del agente con YAML raro tampoco bloquea los totales', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.recordSession(session(1));
    const original = await readFile(agentFile(), 'utf8');
    await writeFile(agentFile(), original.replace('\n---\n', '\nsesiones: 99\nextra: {"a": 1}\n---\n'));
    await memory.recordSession(session(2));
    const after = await readFile(agentFile(), 'utf8');
    expect(after).toContain('\nextra: {"a": 1}\n');
    expect(parseNote(after, { lenient: true }).data).toMatchObject({ sesiones: 2, tokens_entrada: 22_573 + 22_574 });
  });
});

describe('revisión agy, hallazgo 4 (baja): fullHistory tachado', () => {
  it('no devuelve secretos pegados a mano en las notas', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault, extraSecrets: ['clave-del-usuario-1234'] });
    await memory.recordSession(session(1));
    const file = path.join(vault, 'Orquestador', 'Sesiones', '2026-11-01-tarea-1.md');
    await writeFile(file, `${await readFile(file, 'utf8')}\nsk-ant-api03-QQQQQQQQQQQQQQQQQQQQ clave-del-usuario-1234\n`);
    await writeFile(projectFile(), `${await readFile(projectFile(), 'utf8')}\nAIzaSyA1234567890abcdefghijklmnopqrstu\n`);
    const full = await memory.fullHistory('orquestador');
    expect(full).not.toMatch(/sk-ant-api03|clave-del-usuario|AIzaSy/);
    expect(full).toContain('[REDACTADO]');
    const { savings } = await memory.measureContext('orquestador', taskBriefSchema.parse({
      id: 'tarea-1', projectId: 'orquestador', title: 'x', objective: 'x', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['x'], difficulty: 'low',
    }), 1000);
    expect(savings.fullChars).toBe(full.length);
  });
});
