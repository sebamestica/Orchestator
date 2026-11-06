/**
 * agy-09: al (re)abrirse `/ws`, el estado global vuelve a pedir la foto (tareas, agentes, cupos y ajustes), y una
 * foto HTTP vieja no pisa lo que llegó por `/ws` mientras estaba en vuelo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import { LiveConnection } from '../../../src/ui/api/live.ts';
import type { AgentRecord, TaskRecord } from '../../../src/ui/api/types.ts';
import { useApp } from '../../../src/ui/store/app.ts';

const CORE = { url: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: 'k'.repeat(43) };
const at = (sec: number) => new Date(Date.parse('2026-11-04T12:00:00.000Z') + sec * 1000).toISOString();

function task(id: string, state: TaskRecord['state'], updatedAt: string): TaskRecord {
  return {
    task: { id, projectId: 'demo', title: id, objective: id, ownedPaths: [], dependsOn: [], acceptance: [], difficulty: 'medium', contextRefs: [], skillRefs: [] },
    state,
    planId: null,
    agentId: null,
    detail: null,
    attempts: 1,
    createdAt: at(0),
    updatedAt,
    lastEventAt: null,
  } as TaskRecord;
}

function agent(id: string, displayName: string, updatedAt: string): AgentRecord {
  return {
    config: { id, kind: 'codex-cli', provider: 'openai', displayName, quotaFloor: 0.2, enabled: true },
    quotaMethod: null,
    lastProbe: null,
    createdAt: at(0),
    updatedAt,
  } as AgentRecord;
}

/** Núcleo falso: responde con lo que tenga `server` al momento de la petición; `hold` retiene una ruta. */
const server = { tasks: [] as TaskRecord[], agents: [] as AgentRecord[] };
let calls: string[] = [];
let gate: Promise<void> | null = null;
let heldPath = '';

function hold(path: string): () => void {
  let release = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  heldPath = path;
  return () => release();
}

function body(path: string): unknown {
  if (path === '/tasks') return { tasks: server.tasks };
  if (path === '/agents') return { agents: server.agents };
  if (path === '/projects') return { projects: [] };
  if (path === '/quotas') return { quotas: [] };
  return undefined;
}

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

let sockets: FakeSocket[] = [];
let live: LiveConnection | null = null;

/** Como `useBootstrap` en App.tsx: estado de `/ws` a `setLive` y mensajes a `applyLive`. */
function connect(): void {
  live = new LiveConnection(CORE, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  live.onStatus(useApp.getState().setLive);
  live.subscribe(useApp.getState().applyLive);
  live.start();
}

const count = (path: string) => calls.filter((c) => c === path).length;

beforeEach(() => {
  setCoreEndpoint(CORE);
  server.tasks = [];
  server.agents = [];
  calls = [];
  gate = null;
  sockets = [];
  useApp.setState({ tasks: {}, agents: [], quotas: {}, projects: [], live: 'closed' });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname;
    calls.push(path);
    const payload = body(path);
    if (gate && path === heldPath) await gate;
    return payload === undefined
      ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'Ruta no encontrada' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  live?.stop();
  live = null;
  vi.unstubAllGlobals();
});

describe('resincronización al reconectar /ws', () => {
  it.each(['integrated', 'failed'] as const)('una tarea que pasó a %s durante el corte se ve al volver, sin mensaje task', async (state) => {
    server.tasks = [task('t1', 'running', at(1))];
    await useApp.getState().loadAll();
    connect();
    sockets[0]?.open();
    await vi.waitFor(() => expect(useApp.getState().live).toBe('open'));

    sockets[0]?.close();
    server.tasks = [task('t1', state, at(5))];
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 5000 });
    const before = { agents: count('/agents'), quotas: count('/quotas'), settings: count('/settings') };
    sockets[1]?.open();

    await vi.waitFor(() => expect(useApp.getState().tasks.t1?.state).toBe(state));
    await vi.waitFor(() => expect(count('/settings')).toBeGreaterThan(before.settings));
    expect(count('/agents')).toBeGreaterThan(before.agents);
    expect(count('/quotas')).toBeGreaterThan(before.quotas);
  });

  it('la foto de /tasks en vuelo no pisa un task más nuevo ni borra una tarea recién creada', async () => {
    useApp.setState({ tasks: { t1: task('t1', 'running', at(1)) } });
    server.tasks = [task('t1', 'running', at(1))];
    const release = hold('/tasks');

    const done = useApp.getState().refreshTasks();
    await vi.waitFor(() => expect(count('/tasks')).toBe(1));
    useApp.getState().applyLive({ type: 'task', task: task('t1', 'integrated', at(5)) });
    useApp.getState().applyLive({ type: 'task', task: task('t2', 'running', at(6)) });
    release();
    await done;

    expect(useApp.getState().tasks.t1?.state).toBe('integrated');
    expect(useApp.getState().tasks.t2?.state).toBe('running');
  });

  it('la foto de /agents en vuelo no pisa un agente más nuevo ni revive uno borrado', async () => {
    useApp.setState({ agents: [agent('a1', 'Codex', at(1)), agent('a2', 'Viejo', at(1))] });
    server.agents = [agent('a1', 'Codex', at(1)), agent('a2', 'Viejo', at(1))];
    const release = hold('/agents');

    const done = useApp.getState().refreshAgents();
    await vi.waitFor(() => expect(count('/agents')).toBe(1));
    useApp.getState().applyLive({ type: 'agent', agent: agent('a1', 'Codex nuevo', at(5)) });
    useApp.getState().applyLive({ type: 'agent_deleted', agentId: 'a2' });
    release();
    await done;

    expect(useApp.getState().agents.map((a) => [a.config.id, a.config.displayName])).toEqual([['a1', 'Codex nuevo']]);
  });
});
