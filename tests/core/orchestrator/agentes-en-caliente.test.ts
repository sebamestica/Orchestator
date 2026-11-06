import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Router } from '../../../src/core/orchestrator/router.ts';
import { Supervisor } from '../../../src/core/orchestrator/supervisor.ts';
import { agentConfigSchema } from '../../../src/shared/index.ts';
import { agents, FakeQuota, FakeWorkspaces, MemorySink, okScript, ScriptedAdapter, task } from './fakes.ts';

describe('Router.setAgents: agentes en caliente', () => {
  it('cambia los agentes conservando la carga, y release no falla con un agente que ya no está', async () => {
    const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.9)] });
    const d = await router.route(task('t1', { difficulty: 'medium' }));
    expect(d.agentId).toBe('codex');
    expect(router.load('codex')).toBe(1);

    router.setAgents([agents.claude1, agents.agy]);
    expect(router.agent('codex')).toBeUndefined();
    expect(router.load('codex')).toBe(1);
    // La siguiente tarea no puede ir a Codex: lo toma agy.
    expect((await router.route(task('t2', { difficulty: 'medium', suggestedAgent: 'codex' }))).agentId).toBe('agy');
    router.release('codex');
    expect(router.load('codex')).toBe(0);

    // Deshabilitar y el piso propio del agente se aplican al momento.
    router.setAgents([agents.claude1, { ...agents.agy, enabled: false }]);
    expect((await router.route(task('t3', { difficulty: 'medium' }))).agentId).toBe('claude-1');
  });

  it('setQuotaProvider reemplaza el lector de cupo y descarta la lectura en caché', async () => {
    const low = new FakeQuota('codex', 0.05);
    const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [low] });
    expect((await router.checkQuota('codex')).allowed).toBe(false);
    const fresh = new FakeQuota('codex', 0.9);
    router.setQuotaProvider('codex', fresh);
    expect((await router.checkQuota('codex')).allowed).toBe(true);
    expect(fresh.reads).toBe(1);
    router.setQuotaProvider('codex', undefined);
    expect((await router.checkQuota('codex')).warnings.join(' ')).toMatch(/sin proveedor de cupo/);
  });
});

describe('Supervisor.setAdapter / removeAdapter', () => {
  let workspaces: FakeWorkspaces;
  let worktree: string;
  beforeEach(async () => {
    workspaces = await FakeWorkspaces.create();
    worktree = (await workspaces.create('demo', task('t1'))).path;
  });
  afterEach(async () => {
    await workspaces.dispose();
  });

  it('agrega, reemplaza y quita adaptadores después de construirse', async () => {
    const router = new Router({ agents: [agents.claude1] });
    const supervisor = new Supervisor({ adapters: [], router, sink: new MemorySink(), graceMs: 30 });
    expect(supervisor.hasAdapter('claude-1')).toBe(false);

    const first = new ScriptedAdapter(agents.claude1, okScript());
    supervisor.setAdapter(first);
    expect((await supervisor.runAttempt(task('t1'), 'claude-1', { worktreePath: worktree })).ok).toBe(true);

    const renamed = agentConfigSchema.parse({ ...agents.claude1, displayName: 'Claude nuevo' });
    const second = new ScriptedAdapter(renamed, okScript());
    supervisor.setAdapter(second);
    expect((await supervisor.runAttempt(task('t1'), 'claude-1', { worktreePath: worktree })).ok).toBe(true);
    expect([first.calls.length, second.calls.length]).toEqual([1, 1]);

    supervisor.removeAdapter('claude-1');
    expect(supervisor.hasAdapter('claude-1')).toBe(false);
    const gone = await supervisor.runAttempt(task('t1'), 'claude-1', { worktreePath: worktree });
    expect(gone.ok).toBe(false);
    expect(gone.error?.message).toMatch(/No hay adaptador/);
  });
});
