/**
 * autoeval-trabajo-01: las decisiones que la mente guarda con `escribir_memoria` (incluido el «Plan: …») vuelven en
 * `buildContext`, lo que leen `leer_memoria` y cada encargo de la flota. Solo las del proyecto pedido.
 * Ver inssues/autoeval-trabajo-01-decisiones-de-memoria-no-vuelven.md.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObsidianMemory } from '../../../src/core/memory/index.ts';
import type { TaskBrief } from '../../../src/shared/index.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

let vault: string;
beforeEach(async () => { vault = await mkdtemp(join(tmpdir(), 'orq-decisiones-')); });
afterEach(async () => { await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const general = (projectId: string): TaskBrief => taskBriefSchema.parse({
  id: 'contexto-general', projectId, title: 'Contexto general', objective: 'Contexto general',
  ownedPaths: ['docs/**'], dependsOn: [], acceptance: ['ok'], difficulty: 'low',
});

describe('buildContext trae las decisiones del proyecto', () => {
  it('con resumen y sesiones, suma las decisiones del proyecto y no las de otro', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.writeProjectSummary('alfa', 'Proyecto alfa.', '2026-11-01T00:00:00.000Z');
    await memory.recordSession({
      projectId: 'alfa', taskId: 'parser', agentId: 'codex', title: 'Contexto general del parser', outcome: 'ok', summary: 'Parser listo.',
      filesChanged: [], inputTokens: 1, outputTokens: 1, at: '2026-11-02T10:00:00.000Z',
    });
    const own = await memory.recordDecision({ projectId: 'alfa', title: 'Retener T5 hasta aprobación', text: 'T5 publica en GitHub: no se delega hasta que el usuario lea la propuesta.', at: '2026-11-05T01:00:00.000Z' });
    await memory.recordDecision({ projectId: 'beta', title: 'Decisión ajena', text: 'Solo de beta.', at: '2026-11-05T02:00:00.000Z' });

    const context = await memory.buildContext('alfa', general('alfa'), 4_000);
    expect(context).toContain('### Decisiones del proyecto');
    expect(context).toContain('Retener T5 hasta aprobación');
    expect(context).toContain('no se delega hasta que el usuario lea la propuesta');
    expect(context).toContain(own);
    expect(context).toContain('Parser listo.');
    expect(context).not.toMatch(/Decisión ajena|Solo de beta/);
    // Las decisiones van antes que las sesiones: son reglas vigentes, las sesiones son historia.
    expect(context.indexOf('### Decisiones del proyecto')).toBeLessThan(context.indexOf('### Sesiones anteriores pertinentes'));
  });

  it('un proyecto con solo decisiones ya no queda vacío; la más reciente va primero', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    await memory.recordDecision({ projectId: 'alfa', title: 'Usuario de GitHub', text: 'Es sebamestica.', at: '2026-11-04T01:00:00.000Z' });
    await memory.recordDecision({ projectId: 'alfa', title: 'Plan: publicar perfil', text: `${'Paso largo del plan. '.repeat(200)}`, at: '2026-11-05T01:00:00.000Z' });
    const context = await memory.buildContext('alfa', general('alfa'), 4_000);
    const items = context.split('\n').filter((l) => l.startsWith('- '));
    expect(items[0]).toContain('Plan: publicar perfil');
    expect(items[1]).toContain('Usuario de GitHub');
    // Del plan basta el título y la ruta: no se come el presupuesto.
    expect(items[0]?.length ?? 0).toBeLessThan(200);
  });

  it('no pasa del presupuesto', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    for (let i = 0; i < 5; i++) {
      await memory.recordDecision({ projectId: 'alfa', title: `Decisión ${i}`, text: 'Texto de la decisión. '.repeat(40), at: `2026-11-0${i + 1}T01:00:00.000Z` });
    }
    for (const budget of [60, 300, 1_000]) {
      const context = await memory.buildContext('alfa', general('alfa'), budget);
      expect(context.length).toBeLessThanOrEqual(budget);
    }
    expect(await memory.buildContext('alfa', general('alfa'), 300)).toContain('Decisión 4');
  });
});
