import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AgentRegistry, QuotaRefresher } from '../../../src/core/registry/index.ts';
import { EventHub, generateToken, startServer, type HubMessage, type RunningServer } from '../../../src/core/server/index.ts';
import { SqliteStore, type QuotaRecord } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { AgentEvent } from '../../../src/shared/index.ts';
import { fakeKey, fakeQuotaFactory } from './helpers.ts';

const running: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of running.splice(0)) await s.close();
});

async function boot() {
  const token = generateToken();
  const store = new SqliteStore({ path: ':memory:' });
  const registry = new AgentRegistry({ store, vault: new MemoryVault() });
  const hub = new EventHub(store);
  const quotas = new QuotaRefresher<QuotaRecord>({ registry, factory: fakeQuotaFactory(), publish: (s) => hub.publishQuota(s) });
  const server = await startServer({ port: 0, token, store, registry, hub, quotas, validateResponses: true });
  running.push(server);
  return { token, store, registry, hub, server };
}

/** Petición HTTP real con encabezados arbitrarios (incluido Host). */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Client {
  ws: WebSocket;
  next(pred?: (m: HubMessage) => boolean, timeoutMs?: number): Promise<HubMessage>;
  send(data: unknown): void;
}

function connect(url: string, headers: Record<string, string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    const queue: HubMessage[] = [];
    const waiters: { pred: (m: HubMessage) => boolean; resolve: (m: HubMessage) => void }[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as HubMessage;
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0]?.resolve(msg);
      else queue.push(msg);
    });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode ?? 0}`)));
    ws.once('error', (err) => reject(err));
    ws.once('open', () =>
      resolve({
        ws,
        send: (data) => ws.send(typeof data === 'string' ? data : JSON.stringify(data)),
        next: (pred = () => true, timeoutMs = 3000) => {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0] as HubMessage);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('sin mensaje a tiempo')), timeoutMs);
            waiters.push({ pred, resolve: (m) => { clearTimeout(timer); res(m); } });
          });
        },
      }),
    );
  });
}

const ev = (seq: number, text: string): AgentEvent => ({
  sessionId: 'ses-ws',
  agentId: 'codex',
  seq,
  ts: new Date(Date.UTC(2026, 10, 1, 12, 0, seq)).toISOString(),
  type: 'text',
  payload: { text, role: 'assistant' },
});

describe('servidor HTTP real', () => {
  it('escucha solo en 127.0.0.1 y exige token y Host también por la red', async () => {
    const { server, token } = await boot();
    const addr = server.server.address();
    expect(typeof addr === 'object' && addr ? addr.address : '').toBe('127.0.0.1');
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    const ok = await fetch(`${server.url}/health`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect((await fetch(`${server.url}/health`)).status).toBe(401);
    expect((await fetch(`http://localhost:${server.port}/health`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    const rebinding = await rawGet(server.port, '/health', { host: `evil.example:${server.port}`, authorization: `Bearer ${token}` });
    expect(rebinding.status).toBe(403);
    expect(JSON.parse(rebinding.body)).toEqual({ error: { code: 'forbidden_host', message: 'Host no permitido' } });
  });

  it('el handshake del WebSocket exige token, Host propio y ningún Origin ajeno', async () => {
    const { server, token } = await boot();
    await expect(connect(server.wsUrl, {})).rejects.toThrow('HTTP 401');
    await expect(connect(server.wsUrl, { authorization: 'Bearer otro-token-de-32-caracteres-xxxxxxxx' })).rejects.toThrow('HTTP 401');
    await expect(connect(server.wsUrl, { authorization: `Bearer ${token}`, host: 'evil.example' })).rejects.toThrow('HTTP 403');
    await expect(connect(server.wsUrl, { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    await expect(connect(`ws://127.0.0.1:${server.port}/ws?token=${token}`, {})).rejects.toThrow('HTTP 401');
  });

  it('WebSocket: hello, eventos en vivo tachados, replay por seq, ping y mensajes inválidos', async () => {
    const { server, token, hub } = await boot();
    for (let seq = 0; seq < 5; seq++) hub.append(ev(seq, `antes ${seq}`));
    const c = await connect(server.wsUrl, { authorization: `Bearer ${token}` });
    expect(await c.next()).toMatchObject({ type: 'hello', version: '0.1.0' });

    const key = fakeKey();
    hub.append(ev(5, `en vivo ${key}`));
    const live = await c.next((m) => m.type === 'event');
    expect(live.type === 'event' && live.event.seq).toBe(5);
    expect(JSON.stringify(live)).not.toContain(key);
    expect(JSON.stringify(live)).toContain('[REDACTADO]');

    // Reconexión: el cliente vio hasta seq 2 y pide el resto.
    c.send({ type: 'replay', sessionId: 'ses-ws', since: 2 });
    const replay = await c.next((m) => m.type === 'replay');
    expect(replay.type === 'replay' && replay.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(replay).toMatchObject({ lastSeq: 5, hasMore: false });
    c.send({ type: 'replay', sessionId: 'ses-ws', since: -1, limit: 2 });
    expect(await c.next((m) => m.type === 'replay')).toMatchObject({ lastSeq: 1, hasMore: true });

    c.send({ type: 'ping' });
    expect(await c.next((m) => m.type === 'pong')).toEqual({ type: 'pong' });
    c.send('no es json');
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ error: { code: 'invalid_request' } });
    c.send({ type: 'replay', sessionId: '' });
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ type: 'error' });
    // Un duplicado (mismo seq) no se retransmite.
    hub.append(ev(5, 'duplicado'));
    hub.append(ev(6, 'siguiente'));
    const after = await c.next((m) => m.type === 'event');
    expect(after.type === 'event' && after.event.seq).toBe(6);
  });

  it('los cambios de cupo y de agentes llegan por WebSocket', async () => {
    const { server, token } = await boot();
    const c = await connect(server.wsUrl, { authorization: `Bearer ${token}` });
    await c.next((m) => m.type === 'hello');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const created = await fetch(`${server.url}/agents`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' }),
    });
    expect(created.status).toBe(201);
    expect(await c.next((m) => m.type === 'agent')).toMatchObject({ agent: { config: { id: 'codex' } } });
    const refresh = await fetch(`${server.url}/quotas/refresh`, { method: 'POST', headers: auth, body: '{}' });
    expect(refresh.status).toBe(200);
    const quota = await c.next((m) => m.type === 'quota');
    expect(quota).toMatchObject({ type: 'quota', quota: { snapshot: { agentId: 'codex', buckets: [{ remainingFraction: 0.75 }] } } });
    await fetch(`${server.url}/agents/codex`, { method: 'DELETE', headers: auth });
    expect(await c.next((m) => m.type === 'agent_deleted')).toEqual({ type: 'agent_deleted', agentId: 'codex' });
  });

  it('close() corta los WebSocket abiertos y deja de escuchar', async () => {
    const { server, token, hub } = await boot();
    const c = await connect(server.wsUrl, { authorization: `Bearer ${token}` });
    await c.next((m) => m.type === 'hello');
    expect(hub.subscriberCount).toBe(1);
    const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
    await server.close();
    await closed;
    await server.close();
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
    expect(hub.subscriberCount).toBe(0);
  });
});
