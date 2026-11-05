/**
 * Issue 9: la memoria de un proyecto no trae nada de otro. `buildContext` (lo que lee `leer_memoria` y lo que la flota
 * pone en «Memoria del proyecto» de cada encargo) filtra por proyecto aunque otro comparta id de tarea, archivos o
 * palabras del título. Ver docs/plan/issues/09-aislamiento-contexto.md.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObsidianMemory } from '../../../src/core/memory/index.ts';
import type { TaskBrief } from '../../../src/shared/index.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function task(projectId: string, id: string, title: string, ownedPaths: string[]): TaskBrief {
  return taskBriefSchema.parse({ id, projectId, title, objective: title, ownedPaths, dependsOn: [], acceptance: ['ok'], difficulty: 'low' });
}

/** Bóveda con dos proyectos que se parecen: mismo id de tarea, mismos archivos y palabras del título. */
async function twoProjects(): Promise<ObsidianMemory> {
  const vault = await mkdtemp(join(tmpdir(), 'orq-c27-memoria-'));
  dirs.push(vault);
  const memory = new ObsidianMemory({ vaultPath: vault });
  const session = (projectId: string, summary: string, at: string) =>
    memory.recordSession({
      projectId,
      taskId: 'contexto-github',
      agentId: 'claude',
      title: 'Contexto de GitHub desde el Chrome personal',
      outcome: 'ok',
      summary,
      filesChanged: ['docs/contexto.md', 'src/github/index.ts'],
      inputTokens: 10,
      outputTokens: 5,
      at,
    });
  await session('orquestador', 'Sesión propia de orquestador.', '2026-11-05T01:00:00.000Z');
  await session('professional', 'Perfil de sebamestica en professional.', '2026-11-05T01:05:00.000Z');
  await session('professional', 'Segunda sesión de professional.', '2026-11-05T01:16:00.000Z');
  await memory.writeProjectSummary('orquestador', 'Berland: orquestador local.', '2026-11-05T01:00:00.000Z');
  await memory.writeProjectSummary('professional', 'GitHub y LinkedIn del usuario.', '2026-11-05T01:00:00.000Z');
  await memory.recordDecision({ projectId: 'professional', title: 'Usuario de GitHub', text: 'Es sebamestica.', at: '2026-11-05T01:17:00.000Z' });
  await memory.recordPlan({ projectId: 'professional', planId: 'contexto-github', title: 'Plan GitHub', text: 'Plan de professional.', taskIds: ['contexto-github'], at: '2026-11-05T01:05:00.000Z' });
  return memory;
}

const FOREIGN = /professional|sebamestica|LinkedIn|Segunda sesión|Plan de professional/;

describe('buildContext: solo el proyecto pedido', () => {
  it('con la misma tarea, archivos y palabras, no trae sesiones, resumen, decisiones ni planes de otro proyecto', async () => {
    const memory = await twoProjects();
    const brief = task('orquestador', 'contexto-github', 'Contexto de GitHub', ['docs/**', 'src/github/**']);
    const context = await memory.buildContext('orquestador', brief, 4_000);
    expect(context).toContain('### Resumen del proyecto orquestador\nBerland: orquestador local.');
    expect(context).toContain('### Sesiones anteriores pertinentes');
    expect(context).toContain('Sesión propia de orquestador.');
    expect(context).not.toMatch(FOREIGN);
    expect((await memory.listSessions('orquestador')).map((s) => s.notePath)).toEqual(['Orquestador/Sesiones/2026-11-05-contexto-github.md']);
    expect(await memory.fullHistory('orquestador')).not.toMatch(FOREIGN);
  });

  it('el otro proyecto tampoco ve el primero', async () => {
    const memory = await twoProjects();
    const context = await memory.buildContext('professional', task('professional', 'contexto-github', 'Contexto de GitHub', ['docs/**']), 4_000);
    expect(context).toContain('GitHub y LinkedIn del usuario.');
    expect(context).toContain('Segunda sesión de professional.');
    expect(context).not.toMatch(/Berland|Sesión propia de orquestador/);
  });

  it('un proyecto sin memoria propia queda vacío aunque los demás tengan', async () => {
    const memory = await twoProjects();
    expect(await memory.buildContext('marketing', task('marketing', 'contexto-github', 'Contexto de GitHub', ['docs/**']), 4_000)).toBe('');
  });
});
