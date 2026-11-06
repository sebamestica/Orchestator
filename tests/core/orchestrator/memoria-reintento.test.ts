/**
 * datos-05: si la memoria falla al guardar la sesión, la flota reintenta antes de dejar el aviso.
 * Ver inssues/datos-05-memoria-registro-sesion-a-medias.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Fleet } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import type { SessionSummary } from '../../../src/shared/index.ts';
import { agents, FakeMemory, FakeQuota, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task, verdictScript } from './fakes.ts';

class FlakyMemory extends FakeMemory {
  failures: number;
  calls = 0;
  constructor(failures: number) {
    super();
    this.failures = failures;
  }
  override async recordSession(summary: SessionSummary): Promise<void> {
    this.calls++;
    if (this.failures-- > 0) throw new Error('EPERM: Contexto.md retenido');
    await super.recordSession(summary);
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function runWith(memory: FakeMemory): Promise<string[]> {
  const workspaces = await FakeWorkspaces.create();
  cleanups.push(() => workspaces.dispose());
  const queue = new TaskQueue();
  const list = [agents.claude1, agents.codex];
  const router = new Router({ agents: list, quotas: [new FakeQuota('codex', 0.9)] });
  const scripts = { codex: okScript('parser hecho', 'src/parser/index.ts'), 'claude-1': verdictScript('aprobado') };
  const adapters = list.map((a) => new ScriptedAdapter(a, scripts[a.id as keyof typeof scripts] ?? []));
  const supervisor = new Supervisor({ adapters, router, sink: new MemorySink(), queue, graceMs: 30 });
  const warnings: string[] = [];
  const fleet = new Fleet({
    queue, router, supervisor, workspaces, memory, memoryRetryMs: [0, 0],
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    warn: (text) => { warnings.push(text); },
  });
  queue.add(task('parser', { ownedPaths: ['src/parser/**'], suggestedAgent: 'codex' }));
  await fleet.run();
  return warnings.filter((w) => w.includes('no se pudo guardar la sesión'));
}

describe('Fleet: reintento al guardar la sesión en memoria', () => {
  it('un fallo pasajero se reintenta y no deja aviso', async () => {
    const memory = new FlakyMemory(1);
    expect(await runWith(memory)).toEqual([]);
    expect(memory.sessions.map((s) => s.agentId)).toEqual(['codex']);
  });

  it('si sigue fallando, deja el aviso tras los reintentos', async () => {
    const memory = new FlakyMemory(99);
    const warnings = await runWith(memory);
    expect(warnings).toHaveLength(1);
    expect(memory.calls).toBe(3);
  });
});
