import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../../src/core/app/compose.ts';
import { INTERRUPTED_DETAIL } from '../../../src/core/app/fleet-service.ts';
import { ChatDb } from '../../../src/core/chat/index.ts';
import { startCore, type Core } from '../../../src/core/main.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orq-segundo-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

/** Un puerto de 127.0.0.1 ocupado por otro proceso (aquí, un `net.Server`). */
async function busyPort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

/** La base de un núcleo vivo: una tarea `running`, la sesión abierta de su agente y un chat con la mente respondiendo. */
async function liveBase() {
  const dir = await tempDir();
  const store = new SqliteStore({ path: join(dir, 'orquestador.db'), timeZone: 'UTC' });
  cleanups.push(() => store.close());
  store.putTask(
    taskBriefSchema.parse({ id: 't1', projectId: 'demo', title: 'Tarea', objective: 'x', ownedPaths: ['src/**'], dependsOn: [], acceptance: ['y'], difficulty: 'low' }),
    'running',
  );
  store.startSession({ id: 'codex-t1', agentId: 'codex', taskId: 't1' });
  const now = new Date().toISOString();
  new ChatDb(store.database).db
    .prepare(
      `INSERT INTO chat_chats (id, project_id, title, cwd, extra_roots_json, mode, mind_agent_id, session_id, state, cost_usd, created_at, updated_at)
       VALUES ('chat01', NULL, 'Chat', ?, '[]', 'auto', 'claude', 'chat01-sesion', 'running', 0, ?, ?)`,
    )
    .run(dir, now, now);
  const chatState = () => (store.database.prepare(`SELECT state FROM chat_chats WHERE id = 'chat01'`).get() as { state: string }).state;
  return { dir, store, chatState };
}

function composeOn(base: { dir: string; store: SqliteStore }, port: number): Composition {
  const comp = compose({ store: base.store, vault: new MemoryVault(), env: { ORQ_DATA_DIR: base.dir }, config: { port, quotaRefreshMs: 0 }, detectors: [] });
  cleanups.push(() => comp.shutdown());
  return comp;
}

describe('segundo núcleo con el puerto ocupado', () => {
  it('falla con EADDRINUSE sin tocar las tareas, las sesiones ni los chats del núcleo vivo', async () => {
    const base = await liveBase();
    const comp = composeOn(base, await busyPort());
    await expect(startCore(comp.deps)).rejects.toThrow(/EADDRINUSE/);
    expect(base.store.getTask('t1')).toMatchObject({ state: 'running' });
    expect(base.store.getTask('t1')?.detail ?? '').not.toMatch(/interrumpida/);
    expect(base.store.getSession('codex-t1')?.state).toBe('starting');
    expect(base.chatState()).toBe('running');
  });

  it('control: con el puerto libre, el arranque sí pone en orden la base', async () => {
    const base = await liveBase();
    const comp = composeOn(base, 0);
    const core: Core = await startCore(comp.deps);
    cleanups.push(() => core.stop());
    expect(base.store.getTask('t1')).toMatchObject({ state: 'failed', detail: INTERRUPTED_DETAIL });
    expect(base.store.getSession('codex-t1')?.state).toBe('cancelled');
    expect(base.chatState()).toBe('idle');
  });
});
