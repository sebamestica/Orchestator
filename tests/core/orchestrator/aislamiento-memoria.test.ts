/**
 * Issue 9: el encargo de una tarea (`.orq/BRIEF.md`, sección de memoria que arma `Fleet#memoryContext`) trae solo el
 * resumen y las sesiones del proyecto de la tarea, con la memoria real de Obsidian compartida por varios proyectos.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObsidianMemory } from '../../../src/core/memory/index.ts';
import { BRIEF_FILE, Fleet } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import { agents, FakeQuota, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task, verdictScript } from './fakes.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function fleetWith(memory: ObsidianMemory) {
  const workspaces = await FakeWorkspaces.create();
  cleanups.push(() => workspaces.dispose());
  const queue = new TaskQueue();
  const list = [agents.claude1, agents.codex];
  const router = new Router({ agents: list, quotas: [new FakeQuota('codex', 0.9)] });
  const scripts = { codex: okScript('parser hecho', 'src/parser/index.ts'), 'claude-1': verdictScript('aprobado') };
  const adapters = list.map((a) => new ScriptedAdapter(a, scripts[a.id as keyof typeof scripts] ?? []));
  const supervisor = new Supervisor({ adapters, router, sink: new MemorySink(), queue, graceMs: 30 });
  const briefs: string[] = [];
  const fleet = new Fleet({
    queue, router, supervisor, workspaces, memory,
    writeFile: async (path, content) => {
      if (path.endsWith(BRIEF_FILE)) briefs.push(content);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    warn: () => undefined,
  });
  return { queue, fleet, briefs };
}

describe('Fleet: la memoria del encargo es la del proyecto de la tarea', () => {
  it('con sesiones de otro proyecto sobre la misma tarea y los mismos archivos, el BRIEF no trae nada de ese proyecto', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'orq-c27-flota-'));
    cleanups.push(() => rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const memory = new ObsidianMemory({ vaultPath: vault });
    const at = '2026-11-05T01:00:00.000Z';
    await memory.writeProjectSummary('demo', 'Resumen vivo de demo.', at);
    await memory.writeProjectSummary('otro', 'Resumen vivo de otro proyecto.', at);
    for (const [projectId, summary] of [['demo', 'Parser de demo listo.'], ['otro', 'Parser del proyecto ajeno.']] as const) {
      await memory.recordSession({
        projectId, taskId: 'parser', agentId: 'codex', title: 'Tarea parser', outcome: 'ok', summary,
        filesChanged: ['src/parser/index.ts'], inputTokens: 1, outputTokens: 1, at,
      });
    }
    const { queue, fleet, briefs } = await fleetWith(memory);
    queue.add(task('parser-v2', { title: 'Tarea parser', ownedPaths: ['src/parser/**'], suggestedAgent: 'codex' }));
    const report = (await fleet.run()).tasks[0];
    expect(report?.state).toBe('integrated');
    const brief = briefs[0] ?? '';
    expect(brief).toContain('### Resumen del proyecto demo\nResumen vivo de demo.');
    expect(brief).toContain('Parser de demo listo.');
    expect(brief).not.toMatch(/otro proyecto|proyecto ajeno|Proyectos\/otro/);
  });
});
