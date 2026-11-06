/**
 * datos-03: `buildContext` no vuelve a abrir en cada encargo todas las notas de `Sesiones/` (de todos los proyectos).
 * Las notas ya leídas quedan en caché por nombre, mtime y tamaño: la segunda llamada solo abre lo nuevo o editado,
 * y el contexto es el mismo que el de una bóveda con solo las sesiones del proyecto.
 * Ver inssues/datos-03-memoria-contexto-lee-todas-las-sesiones.md.
 */
import { mkdir, mkdtemp, readFile as realReadFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringifyNote } from '../../../src/core/memory/frontmatter.ts';
import { ObsidianMemory } from '../../../src/core/memory/index.ts';
import type { TaskBrief } from '../../../src/shared/index.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

const reads = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = vi.fn((...args: Parameters<typeof orig.readFile>) => {
    reads.files.push(String(args[0]));
    return orig.readFile(...args);
  });
  return { ...orig, readFile, default: { ...orig, readFile } };
});

/** Pocas para no cargar el disco (Defender revisa cada archivo); basta para ver que no se abren. */
const FOREIGN_NOTES = 300;

const dirs: string[] = [];
beforeEach(() => { reads.files.length = 0; });
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const brief: TaskBrief = taskBriefSchema.parse({
  id: 'memoria-escala', projectId: 'alfa', title: 'Memoria que escala', objective: 'Contexto barato',
  ownedPaths: ['src/core/memory/**'], dependsOn: [], acceptance: ['ok'], difficulty: 'low',
});

const sessionReads = () => reads.files.filter((f) => /[\\/]Sesiones[\\/]/.test(f)).length;

async function alfaVault(): Promise<{ vault: string; memory: ObsidianMemory }> {
  const vault = await mkdtemp(join(tmpdir(), 'orq-escala-'));
  dirs.push(vault);
  const memory = new ObsidianMemory({ vaultPath: vault });
  for (let i = 1; i <= 5; i++) {
    await memory.recordSession({
      projectId: 'alfa', taskId: `alfa-${i}`, agentId: 'claude', title: `Memoria alfa ${i}`, outcome: 'ok',
      summary: `Sesión ${i} de alfa sobre la memoria.`, filesChanged: [`src/core/memory/m${i}.ts`],
      inputTokens: 10, outputTokens: 5, at: `2026-11-0${i}T10:00:00.000Z`,
    });
  }
  await memory.writeProjectSummary('alfa', 'Proyecto alfa.', '2026-11-01T00:00:00.000Z');
  return { vault, memory };
}

async function addForeignSessions(vault: string): Promise<void> {
  const dir = join(vault, 'Orquestador', 'Sesiones');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < FOREIGN_NOTES; i++) {
    const data = { tipo: 'sesion', proyecto: 'beta', tarea: `beta-${i}`, agente: 'codex', resultado: 'ok', fecha: '2026-11-03', at: '2026-11-03T10:00:00.000Z', titulo: `Memoria beta ${i}`, archivos: ['src/core/memory/m1.ts'] };
    await writeFile(join(dir, `2026-11-03-beta-${i}.md`), stringifyNote(data, `# Memoria beta ${i}\n\n## Resumen\nTexto de beta ${i}.`));
  }
}

describe('datos-03: buildContext con muchas sesiones de otros proyectos', () => {
  it('la segunda llamada no vuelve a abrir las notas de Sesiones/ y el contexto no cambia', async () => {
    const { memory: clean } = await alfaVault();
    const expected = await clean.buildContext('alfa', brief, 4_000);

    const { vault, memory } = await alfaVault();
    await addForeignSessions(vault);
    const first = await memory.buildContext('alfa', brief, 4_000);
    expect(first).toBe(expected);

    reads.files.length = 0;
    const second = await memory.buildContext('alfa', brief, 4_000);
    expect(second).toBe(expected);
    expect(second).not.toMatch(/beta/);
    expect(sessionReads()).toBeLessThanOrEqual(5);
    expect(reads.files.length).toBeLessThanOrEqual(6);
  });

  it('measureContext lee cada nota una sola vez', async () => {
    const { vault } = await alfaVault();
    await addForeignSessions(vault);
    const fresh = new ObsidianMemory({ vaultPath: vault });
    reads.files.length = 0;
    const { context } = await fresh.measureContext('alfa', brief, 4_000);
    expect(context).toContain('Memoria alfa 1');
    expect(sessionReads()).toBeLessThanOrEqual(5 + FOREIGN_NOTES);
  });

  it('una nota editada en Obsidian se vuelve a leer', async () => {
    const { vault, memory } = await alfaVault();
    await memory.buildContext('alfa', brief, 4_000);
    const file = join(vault, 'Orquestador', 'Sesiones', '2026-11-01-alfa-1.md');
    const text = await realReadFile(file, 'utf8');
    await writeFile(file, text.replace('Sesión 1 de alfa sobre la memoria.', 'Sesión 1 de alfa, corregida a mano.'));
    expect(await memory.buildContext('alfa', brief, 4_000)).toContain('corregida a mano');
  });
});
