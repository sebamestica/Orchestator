import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TASK_DETAIL_CHARS, SqliteStore } from '../../../src/core/store/index.ts';
import { MIGRATIONS } from '../../../src/core/store/schema.ts';
import { REDACTED, taskBriefSchema, type TaskBrief } from '../../../src/shared/index.ts';
import { textEvent } from './fixture-events.ts';

let dir: string;
const stores: SqliteStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-task-detail-'));
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await rm(dir, { recursive: true, force: true });
});

function open(path = ':memory:', now?: () => Date): SqliteStore {
  const s = new SqliteStore({ path, timeZone: 'UTC', ...(now ? { now } : {}) });
  stores.push(s);
  return s;
}

function task(id: string): TaskBrief {
  return taskBriefSchema.parse({ id, projectId: 'demo', title: `Tarea ${id}`, objective: 'x', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['y'], difficulty: 'low' });
}

const KEY = `sk-ant-api03-${'Z'.repeat(40)}`;

describe('tareas: motivo, intentos y último evento', () => {
  it('guarda el motivo de cada cambio (tachado y recortado), lo conserva si no viene y lo borra con null', () => {
    const s = open();
    s.putTask(task('t1'));
    expect(s.getTask('t1')).toMatchObject({ detail: null, attempts: 0, lastEventAt: null });

    const failed = s.setTaskState('t1', 'failed', 'codex', { detail: `el agente usó ${KEY} y falló` });
    expect(failed.state).toBe('failed');
    expect(failed.detail).toContain(REDACTED);
    expect(failed.detail).not.toContain('sk-ant-api03');
    // Un cambio sin motivo (p. ej. cancelar desde el servidor) conserva el anterior.
    expect(s.setTaskState('t1', 'failed').detail).toBe(failed.detail);
    expect(s.setTaskState('t1', 'ready', undefined, { detail: null }).detail).toBeNull();

    const long = s.setTaskState('t1', 'failed', undefined, { detail: 'x'.repeat(MAX_TASK_DETAIL_CHARS + 500) });
    expect(long.detail).toHaveLength(MAX_TASK_DETAIL_CHARS);
    expect(long.detail?.endsWith('…')).toBe(true);
    expect(s.setTaskState('t1', 'failed', undefined, { detail: '   ' }).detail).toBeNull();
    // También en la lista.
    expect(s.listTasks({ state: 'failed' })[0]).toMatchObject({ detail: null, attempts: 0 });
  });

  it('cuenta un intento cada vez que la flota la empieza', () => {
    const s = open();
    s.putTask(task('t2'));
    s.setTaskState('t2', 'running', 'claude', { countAttempt: true });
    s.setTaskState('t2', 'review');
    s.setTaskState('t2', 'running', undefined, { countAttempt: true });
    expect(s.getTask('t2')).toMatchObject({ attempts: 2, agentId: 'claude' });
  });

  it('la hora del último evento sale de las sesiones enlazadas a la tarea (autor y revisor)', () => {
    const s = open();
    s.putTask(task('t3'));
    s.putTask(task('otra'));
    s.append(textEvent('autor-1', 'codex', 0, '2026-11-04T18:06:00.000Z', 'empiezo'));
    // Sin enlazar, la sesión no cuenta para la tarea.
    expect(s.getTask('t3')?.lastEventAt).toBeNull();
    s.startSession({ id: 'autor-1', agentId: 'codex', taskId: 't3' });
    s.append(textEvent('autor-1', 'codex', 1, '2026-11-04T19:10:00.000Z', 'sigo'));
    s.append(textEvent('revisor-1', 'claude-1', 0, '2026-11-04T19:40:00.000Z', 'reviso'));
    s.startSession({ id: 'revisor-1', agentId: 'claude-1', taskId: 't3' });
    s.append(textEvent('ajena', 'claude-1', 0, '2026-11-04T23:00:00.000Z', 'otra cosa'));
    s.startSession({ id: 'ajena', agentId: 'claude-1', taskId: 'otra' });

    expect(s.getTask('t3')?.lastEventAt).toBe('2026-11-04T19:40:00.000Z');
    expect(s.getTask('otra')?.lastEventAt).toBe('2026-11-04T23:00:00.000Z');
    expect(s.listTasks().find((t) => t.task.id === 't3')?.lastEventAt).toBe('2026-11-04T19:40:00.000Z');
    // El estado de la tarea no cambió: `updatedAt` sigue igual; el avance se ve en `lastEventAt`.
    expect(s.getTask('t3')?.state).toBe('pending');
  });

  it('cierra las sesiones abiertas como canceladas sin tocar la hora del último evento, salvo los agentes indicados', () => {
    const s = open(':memory:', () => new Date('2026-11-05T08:00:00.000Z'));
    s.append(textEvent('viva', 'codex', 0, '2026-11-04T20:00:00.000Z', 'trabajando'));
    s.append(textEvent('mente', 'orquestador', 0, '2026-11-04T20:01:00.000Z', 'hola'));
    s.append({ sessionId: 'terminada', agentId: 'codex', seq: 0, ts: '2026-11-04T20:02:00.000Z', type: 'done', payload: { ok: true } });
    expect(s.getSession('viva')?.state).toBe('running');

    expect(s.cancelOpenSessions({ exceptAgents: ['orquestador'] })).toBe(1);
    expect(s.getSession('viva')).toMatchObject({ state: 'cancelled', updatedAt: '2026-11-04T20:00:00.000Z', endedAt: '2026-11-05T08:00:00.000Z' });
    expect(s.getSession('mente')?.state).toBe('running');
    expect(s.getSession('terminada')?.state).toBe('done');
    expect(s.cancelOpenSessions()).toBe(1);
  });

  it('al arrancar cancela las sesiones hijas de la mente (no se retoman) y respeta la sesión principal de cada chat', () => {
    const s = open(':memory:', () => new Date('2026-11-05T08:00:00.000Z'));
    s.append({ sessionId: 'chat-1', agentId: 'orquestador', seq: 0, ts: '2026-11-04T20:00:00.000Z', type: 'status', payload: { state: 'running' } });
    s.append({ sessionId: 'toolu_x', agentId: 'orquestador', parentSessionId: 'chat-1', seq: 1, ts: '2026-11-04T20:01:00.000Z', type: 'status', payload: { state: 'running', detail: 'investigar' } });
    s.append(textEvent('worker', 'codex', 0, '2026-11-04T20:02:00.000Z', 'trabajando'));

    expect(s.cancelOpenSessions({ exceptAgents: ['orquestador'] })).toBe(2);
    expect(s.getSession('toolu_x')).toMatchObject({ state: 'cancelled', endedAt: '2026-11-05T08:00:00.000Z' });
    expect(s.getSession('worker')?.state).toBe('cancelled');
    expect(s.getSession('chat-1')?.state).toBe('running');
  });

  it('una sesión que vuelve a un estado abierto tras su done queda sin hora de fin', () => {
    const s = open();
    s.append({ sessionId: 'chat-1', agentId: 'orquestador', seq: 0, ts: '2026-11-04T20:00:00.000Z', type: 'done', payload: { ok: true } });
    expect(s.getSession('chat-1')).toMatchObject({ state: 'done', endedAt: '2026-11-04T20:00:00.000Z' });
    s.append({ sessionId: 'chat-1', agentId: 'orquestador', seq: 1, ts: '2026-11-04T20:05:00.000Z', type: 'status', payload: { state: 'running' } });
    expect(s.getSession('chat-1')).toMatchObject({ state: 'running', endedAt: null });
  });

  it('migra una base v2: las tareas existentes quedan sin motivo y con cero intentos', () => {
    const path = join(dir, 'v2.db');
    const db = new DatabaseSync(path);
    db.exec(MIGRATIONS[0] ?? '');
    db.exec(MIGRATIONS[1] ?? '');
    db.exec('PRAGMA user_version = 2');
    db.prepare('INSERT INTO tasks (id, project_id, plan_id, state, agent_id, brief_json, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)').run(
      'vieja',
      'demo',
      'failed',
      'codex',
      JSON.stringify(task('vieja')),
      '2026-11-04T18:06:00.000Z',
      '2026-11-04T23:39:00.000Z',
    );
    db.close();

    const s = open(path);
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    expect(s.getTask('vieja')).toMatchObject({ state: 'failed', agentId: 'codex', detail: null, attempts: 0, lastEventAt: null });
    s.setTaskState('vieja', 'failed', undefined, { detail: 'motivo nuevo' });
    s.close();
    stores.splice(0);
    expect(open(path).getTask('vieja')?.detail).toBe('motivo nuevo');
  });
});
