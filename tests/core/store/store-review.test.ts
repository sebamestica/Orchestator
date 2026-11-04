import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore, StoreError } from '../../../src/core/store/index.ts';
import type { AgentEvent } from '../../../src/shared/index.ts';

const KEY = `sk-ant-${'r'.repeat(12)}${Date.now().toString(36)}`;

let dir: string;
const open: SqliteStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-store-rev-'));
});
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function fileStore(): { store: SqliteStore; bytes: () => string } {
  const path = join(dir, 'o.db');
  const store = new SqliteStore({ path, timeZone: 'UTC' });
  open.push(store);
  const bytes = () => [path, `${path}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p).toString('latin1')).join('');
  return { store, bytes };
}

function invalid(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe('invalid');
    return err as StoreError;
  }
  throw new Error('se esperaba StoreError');
}

const ev = (sessionId: string, seq: number): AgentEvent => ({ sessionId, agentId: 'codex', seq, ts: '2026-11-01T12:00:00.000Z', type: 'text', payload: { text: `e${seq}`, role: 'assistant' } });

// Revisión de seguridad 2026-11-01 (Codex), hallazgos 2 y 6.
describe('revisión: proyectos y demás escrituras se tachan antes de guardar (hallazgo 2)', () => {
  it('putProject tacha name y repoPath en SQLite y devuelve lo mismo que guardó', () => {
    const { store, bytes } = fileStore();
    const saved = store.putProject({ id: 'proyecto-1', name: `Proyecto ${KEY}`, repoPath: `C:\\dev\\${KEY}` });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(saved).toEqual(store.getProject('proyecto-1'));
    expect(saved.name).toContain('[REDACTADO]');
    expect(bytes()).not.toContain(KEY);
  });

  it('startSession tacha sus ids igual que appendEvent (una sola sesión, sin la clave en disco)', () => {
    const { store, bytes } = fileStore();
    const sessionId = `ses-${KEY}`;
    store.startSession({ id: sessionId, agentId: 'codex', taskId: 'tarea-1', parentSessionId: `padre-${KEY}` });
    store.appendEvent(ev(sessionId, 0));
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.taskId).toBe('tarea-1');
    expect(store.eventsSince(sessions[0]?.id ?? '', -1)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(KEY);
    expect(bytes()).not.toContain(KEY);
  });

  it('rechaza ids con forma de clave en vez de guardar un id tachado que luego no se puede leer', () => {
    const { store, bytes } = fileStore();
    invalid(() => store.putAgent({ config: { id: KEY, kind: 'codex-cli', provider: 'codex', displayName: 'x', quotaFloor: 0.2, enabled: true } }));
    invalid(() => store.putProject({ id: KEY, name: 'x', repoPath: 'C:\\x' }));
    store.putProject({ id: 'proyecto-1', name: 'x', repoPath: 'C:\\x' });
    const task = { id: KEY, projectId: 'proyecto-1', title: 't', objective: 'o', ownedPaths: ['a'], dependsOn: [], acceptance: ['ok'], difficulty: 'low' as const, contextRefs: [], skillRefs: [] };
    invalid(() => store.putTask(task));
    invalid(() => store.createPlan({ id: KEY, projectId: 'proyecto-1', text: 'x', tasks: [] }));
    invalid(() => store.appendEvent({ ...ev('s', 0), agentId: KEY }));
    invalid(() => store.recordQuota({ agentId: KEY, method: 'none', takenAt: '2026-11-01T12:00:00.000Z', buckets: [], stale: false }));
    store.putTask({ ...task, id: 'tarea-1' });
    invalid(() => store.setTaskState('tarea-1', 'ready', KEY));
    invalid(() => store.setTaskState('tarea-1', 'ready', 'NO VALIDO'));
    // Todo sigue legible.
    expect(store.listAgents()).toEqual([]);
    expect(store.listTasks().map((t) => t.task.id)).toEqual(['tarea-1']);
    expect(store.listProjects()).toHaveLength(1);
    expect(bytes()).not.toContain(KEY);
  });
});

describe('revisión: paginación de eventos con el límite máximo (hallazgo 6)', () => {
  it('eventsPage con limit=5000 y 5001 eventos anuncia hasMore y no pierde el último', () => {
    const store = new SqliteStore({ path: ':memory:' });
    open.push(store);
    for (let seq = 0; seq < 5001; seq++) store.appendEvent(ev('s', seq));
    const first = store.eventsPage('s', -1, 5000);
    expect(first.events).toHaveLength(5000);
    expect(first).toMatchObject({ lastSeq: 4999, hasMore: true });
    const second = store.eventsPage('s', first.lastSeq, 5000);
    expect(second.events.map((e) => e.seq)).toEqual([5000]);
    expect(second).toMatchObject({ lastSeq: 5000, hasMore: false });
    expect(store.eventsPage('s', 5000)).toEqual({ events: [], lastSeq: 5000, hasMore: false });
    // Límites fuera de rango se acotan a 1..5000.
    expect(store.eventsPage('s', -1, 0).events).toHaveLength(1);
    expect(store.eventsPage('s', -1, 99_999).events).toHaveLength(5000);
  });
});
