import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, generateToken, startServer, type HubMessage, type RunningServer } from '../../../src/core/server/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { AgentEvent } from '../../../src/shared/index.ts';
import { makeTestApp } from './helpers.ts';

const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

const ev = (seq: number): AgentEvent => ({ sessionId: 'ses-1', agentId: 'codex', seq, ts: '2026-11-01T12:00:00.000Z', type: 'text', payload: { text: `e${seq}`, role: 'assistant' } });

// Revisión de seguridad 2026-11-01 (Codex), hallazgos 3 y 6.
describe('revisión: el registro de acceso no guarda secretos de la URL (hallazgo 3)', () => {
  it('registra la plantilla de ruta (o «ruta desconocida») y nunca la URL cruda', async () => {
    const t = makeTestApp();
    const key = `sk-ant-${randomBytes(20).toString('hex')}`;
    expect((await t.req('GET', `/${key}`, { token: null })).status).toBe(401);
    expect((await t.req('GET', `/agents/${key}`, { token: null })).status).toBe(401);
    expect((await t.req('GET', `/agents/${key}`)).status).toBe(404);
    expect((await t.req('GET', `/sessions/x${key}/events?since=-1`)).status).toBe(404);
    expect((await t.req('GET', `/${key}`)).status).toBe(404);
    const log = t.logLines.join('\n');
    expect(log).not.toContain(key);
    expect(log).not.toContain(key.slice(7));
    expect(t.logLines.map((l) => l.replace(/ \d+ms$/, ''))).toEqual([
      'GET (ruta desconocida) 401',
      'GET /agents/:id 401',
      'GET /agents/:id 404',
      'GET /sessions/:id/events 404',
      'GET (ruta desconocida) 404',
    ]);
  });
});

describe('revisión: reconexión con el límite máximo (hallazgo 6)', () => {
  it('REST: limit=5000 con 5001 eventos → hasMore y la página siguiente trae el último', async () => {
    const t = makeTestApp();
    for (let seq = 0; seq < 5001; seq++) t.store.appendEvent(ev(seq));
    const first = await t.req('GET', '/sessions/ses-1/events?limit=5000');
    expect((first.json.events as unknown[]).length).toBe(5000);
    expect(first.json).toMatchObject({ lastSeq: 4999, hasMore: true });
    const second = await t.req('GET', '/sessions/ses-1/events?since=4999&limit=5000');
    expect((second.json.events as AgentEvent[]).map((e) => e.seq)).toEqual([5000]);
    expect(second.json).toMatchObject({ lastSeq: 5000, hasMore: false });
  });

  it('WebSocket: replay con limit=5000 y 5001 eventos → hasMore', async () => {
    const token = generateToken();
    const store = new SqliteStore({ path: ':memory:' });
    const hub = new EventHub(store);
    const server = await startServer({ port: 0, token, store, registry: new AgentRegistry({ store, vault: new MemoryVault() }), hub });
    running.push(server);
    for (let seq = 0; seq < 5001; seq++) store.appendEvent(ev(seq));
    const ws = new WebSocket(server.wsUrl, { headers: { authorization: `Bearer ${token}` }, maxPayload: 16 * 1024 * 1024 });
    const replay = await new Promise<HubMessage>((resolve, reject) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as HubMessage;
        if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'replay', sessionId: 'ses-1', since: -1, limit: 5000 }));
        if (msg.type === 'replay') resolve(msg);
      });
      ws.once('error', reject);
    });
    ws.terminate();
    expect(replay.type === 'replay' && replay.events.length).toBe(5000);
    expect(replay).toMatchObject({ lastSeq: 4999, hasMore: true });
  });
});
