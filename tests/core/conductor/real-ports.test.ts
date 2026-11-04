/**
 * Las piezas reales que ya están en main encajan en los puertos sin adaptadores:
 * `QuotaMonitor` como `QuotaPort` y `ObsidianMemory` como `ConductorMemoryPort` (bóveda temporal).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConductorTools } from '../../../src/core/conductor/index.ts';
import type { ConductorMemoryPort, QuotaPort } from '../../../src/core/conductor/index.ts';
import { ObsidianMemory } from '../../../src/core/memory/index.ts';
import { QuotaMonitor } from '../../../src/core/quota/monitor.ts';
import { minRemainingFraction } from '../../../src/shared/index.ts';
import { FAKE_API_KEY, NOW, SECRET_PATTERN, fakePorts, fixtureQuotas, jsonOf, textOf } from './fakes.ts';

let vault: string;
beforeEach(async () => { vault = await mkdtemp(path.join(os.tmpdir(), 'orq-conductor-')); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

describe('puertos con las piezas reales de main', () => {
  it('cupos lee la última foto de QuotaMonitor (proveedores con fixtures reales)', async () => {
    const snapshots = await fixtureQuotas();
    const monitor = new QuotaMonitor(
      snapshots.map((s) => ({ agentId: s.agentId, read: async () => s })),
      { setInterval: () => 0, clearInterval: () => undefined },
    );
    const quotas: QuotaPort = monitor;
    await monitor.refresh();
    const tools = createConductorTools({ ...fakePorts(), quotas }, { now: () => NOW });
    const agents = jsonOf(await tools.call('cupos', {})).agentes as { agente: string; restantePct: number | null }[];
    expect(agents.map((a) => a.agente)).toEqual(snapshots.map((s) => s.agentId));
    for (const [i, s] of snapshots.entries()) {
      const min = minRemainingFraction(s);
      expect(agents[i]?.restantePct).toBe(min === null ? null : Math.round(min * 1000) / 10);
    }
    monitor.stop();
  });

  it('escribir_memoria y leer_memoria contra ObsidianMemory', async () => {
    const memory: ConductorMemoryPort = new ObsidianMemory({ vaultPath: vault });
    const ports = fakePorts();
    const tools = createConductorTools({ ...ports, memory }, { defaultProjectId: 'demo', now: () => NOW });

    const summary = await tools.call('escribir_memoria', { proyecto: 'demo', nota: { tipo: 'resumen', texto: `Fase F3: orquestador listo. Clave ${FAKE_API_KEY}` } });
    expect(summary.isError).toBeFalsy();
    const decision = await tools.call('escribir_memoria', { proyecto: 'demo', nota: { tipo: 'decision', titulo: 'Orquestador sin Bash', texto: 'Delega; no edita.' } });
    expect(jsonOf(decision)).toMatchObject({ ok: true, tipo: 'decision', nota: expect.stringMatching(/^Orquestador\/Decisiones\/2026-11-01-/) });

    const context = textOf(await tools.call('leer_memoria', { proyecto: 'demo' }));
    expect(context).toMatch(/^Memoria de demo \(máx\. 4000 caracteres\):/);
    expect(context).toContain('Fase F3: orquestador listo.');
    expect(context).not.toMatch(SECRET_PATTERN);

    await tools.call('crear_tareas', { plan: 'plan' });
    const forTask = await tools.call('leer_memoria', { proyecto: 'demo', tarea: 'api' });
    expect(forTask.isError).toBeFalsy();
    expect(textOf(forTask)).toMatch(/para api/);
  });
});
