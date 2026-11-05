import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Fleet } from '../../../src/core/orchestrator/fleet.ts';
import { TaskQueue, type TaskStateChange } from '../../../src/core/orchestrator/queue.ts';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import type { TaskBrief } from '../../../src/shared/index.ts';
import { agents, FakeMemory, FakeQuota, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task, verdictScript, type Step } from './fakes.ts';

const disposables: FakeWorkspaces[] = [];
afterEach(async () => {
  for (const w of disposables.splice(0)) await w.dispose();
});

const isReview = (t: TaskBrief) => t.id.endsWith('-revision');

async function setup(opts: { exclusiveKey: (projectId: string) => string | undefined; localProjects?: readonly string[] }) {
  const workspaces = await FakeWorkspaces.create();
  disposables.push(workspaces);
  const queue = new TaskQueue({ concurrency: 3 });
  const changes: TaskStateChange[] = [];
  queue.on((c) => changes.push(c));
  const list = [agents.claude1, agents.claude2, agents.codex];
  const router = new Router({ agents: list, quotas: [new FakeQuota('codex', 0.9)] });
  const work = (t: TaskBrief): Step[] => (isReview(t) ? verdictScript('aprobado') : [{ wait: 80 }, ...okScript(t.id)]);
  const adapters = list.map((a) => new ScriptedAdapter(a, work));
  const supervisor = new Supervisor({ adapters, router, sink: new MemorySink(), queue, graceMs: 30 });
  const writes: { path: string; content: string }[] = [];
  const local = new Set(opts.localProjects ?? []);
  const fleet = new Fleet({
    queue, router, supervisor, workspaces, memory: new FakeMemory(),
    writeFile: async (path, content) => {
      writes.push({ path, content });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    exclusiveKey: opts.exclusiveKey,
    // FakeWorkspaces crea `<raíz>/<proyecto>/<tarea>`: el proyecto sale de la ruta.
    isLocal: (ws) => [...local].some((p) => ws.path.includes(`${p}`)),
    warn: () => undefined,
  });
  return { queue, changes, fleet, writes };
}

/** Máximo de tareas activas a la vez entre las que cumplen `pick`. */
function maxActive(changes: readonly TaskStateChange[], pick: (taskId: string) => boolean): number {
  const activeStates = new Set(['running', 'handed_off', 'review']);
  let active = 0;
  let max = 0;
  for (const c of changes) {
    if (!pick(c.taskId)) continue;
    const was = c.from !== null && activeStates.has(c.from);
    const is = activeStates.has(c.to);
    if (!was && is) active++;
    if (was && !is) active--;
    max = Math.max(max, active);
  }
  return max;
}

describe('Fleet: modo local (una tarea a la vez por carpeta)', () => {
  it('dos tareas del mismo proyecto local nunca están activas a la vez; la de otro proyecto corre en paralelo', async () => {
    const s = await setup({ exclusiveKey: (projectId) => (projectId === 'marketing' ? 'local:c:\\dev\\marketing' : undefined) });
    s.queue.addAll([
      task('m1', { projectId: 'marketing', ownedPaths: ['5/investigacion/mercado/**'] }),
      task('m2', { projectId: 'marketing', ownedPaths: ['5/investigacion/datos/**'] }),
      task('d1', { projectId: 'demo' }),
    ]);
    const report = await s.fleet.run();
    expect(report.states).toEqual({ m1: 'integrated', m2: 'integrated', d1: 'integrated' });
    const local = (id: string) => id === 'm1' || id === 'm2';
    expect(maxActive(s.changes, local)).toBe(1);
    // La de `demo` no esperó a las locales: corrió junto a una de ellas.
    expect(maxActive(s.changes, () => true)).toBe(2);
    const order = s.changes.map((c) => `${c.taskId}:${c.to}`);
    expect(order.indexOf('m2:running')).toBeGreaterThan(order.indexOf('m1:integrated'));
  });

  it('sin clave de exclusión (worktrees) las tareas del mismo proyecto corren en paralelo', async () => {
    const s = await setup({ exclusiveKey: () => undefined });
    s.queue.addAll([task('a1'), task('a2')]);
    const report = await s.fleet.run();
    expect(report.states).toEqual({ a1: 'integrated', a2: 'integrated' });
    expect(maxActive(s.changes, () => true)).toBe(2);
  });

  it('el encargo de una tarea local lleva la sección «Modo local» (sin commits ni ramas)', async () => {
    const s = await setup({ exclusiveKey: () => 'local:x', localProjects: ['marketing'] });
    s.queue.add(task('m1', { projectId: 'marketing' }));
    await s.fleet.run();
    const brief = s.writes.find((w) => w.path.endsWith('BRIEF.md'))?.content ?? '';
    expect(brief).toContain('## Modo local (sin worktree)');
    expect(brief).toMatch(/No hagas commits ni ramas/);
  });
});

describe('TaskQueue.next(canStart)', () => {
  it('salta las tareas listas que no pueden empezar y las deja en ready', () => {
    const q = new TaskQueue({ concurrency: 3 });
    q.addAll([task('ta'), task('tb'), task('tc')]);
    expect(q.next((t) => t.id !== 'ta')?.id).toBe('tb');
    expect(q.state('ta')).toBe('ready');
    expect(q.next((t) => t.id === 'zzz')).toBeUndefined();
    expect(q.next()?.id).toBe('ta');
  });
});
