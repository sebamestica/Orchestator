/** Rutas REST del chat sobre la app real (`createApp`), con validación de respuestas y la `query` falsa del SDK. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSdkTranslator } from '../../../src/core/adapters/claude-sdk/index.ts';
import { AttachmentStore, ChatService, registerChatRoutes } from '../../../src/core/chat/index.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, type CoreApp, type HubMessage } from '../../../src/core/server/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { DEFAULT_SETTINGS, MAX_ATTACHMENT_BYTES } from '../../../src/shared/index.ts';
import type { Chat } from '../../../src/shared/index.ts';
import { fakePorts, type FakePorts } from '../conductor/fakes.ts';
import { MIND_KEY, PNG, chatQuery, claudeAgent, echoTurn, tick, type ChatQuery } from './helpers.ts';

const HOST = '127.0.0.1:47999';

let dir: string;
let store: SqliteStore;
let core: CoreApp;
let token: string;
let ports: FakePorts;
let q: ChatQuery;
let service: ChatService | undefined;
let published: HubMessage[];
let release: () => void;
/** Deja el próximo turno esperando hasta `release()` o una interrupción. */
let hold: () => void = () => undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-chat-rutas-'));
  store = new SqliteStore({ path: ':memory:' });
  store.putProject({ id: 'demo', name: 'Demo', repoPath: dir });
  const hub = new EventHub(store);
  published = [];
  hub.subscribe((m) => published.push(m));
  const registry = new AgentRegistry({ store, vault: new MemoryVault(), detectors: [] });
  ports = fakePorts();
  let gate = Promise.resolve();
  release = () => undefined;
  q = chatQuery(async (m, ctx) => {
    await Promise.race([gate, ctx.stopped]);
    return echoTurn(m, ctx);
  });
  hold = () => {
    gate = new Promise((r) => {
      release = r;
    });
  };
  token = generateToken();
  core = createApp({
    token,
    allowedHosts: () => [HOST],
    store,
    registry,
    hub,
    validateResponses: true,
    routeModules: [
      (ctx) => {
        const attachments = new AttachmentStore({ db: ctx.store.database, dir: join(dir, 'attachments') });
        service = new ChatService({
          db: ctx.store.database,
          store: ctx.store,
          hub: ctx.hub,
          settings: () => DEFAULT_SETTINGS,
          mind: { agents: () => [claudeAgent], env: async () => ({ ANTHROPIC_API_KEY: MIND_KEY }) },
          ports,
          translator: (init) => new ClaudeSdkTranslator(init),
          attachments,
          query: q.fn,
          drives: () => ['C:\\'],
        });
        registerChatRoutes(ctx, { service, attachments });
      },
    ],
  });
});
afterEach(async () => {
  service?.shutdown();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers: { host: HOST, authorization: `Bearer ${token}`, ...headers } };
  if (body instanceof Uint8Array) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  return Promise.resolve(core.app.request(`http://${HOST}${path}`, init));
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function idle(chatId: string): Promise<Chat> {
  for (let i = 0; i < 400; i++) {
    const { chat } = await json<{ chat: Chat }>(await call('GET', `/chats/${chatId}`));
    if (chat.state !== 'running') {
      await tick();
      return chat;
    }
    await tick();
  }
  throw new Error('el chat sigue running');
}

describe('rutas /chats', () => {
  it('crear, listar, detalle, cambiar modo, mensajes, 409, interrumpir, cerrar y borrar', async () => {
    const created = await call('POST', '/chats', { projectId: 'demo' });
    expect(created.status).toBe(201);
    const { chat } = await json<{ chat: Chat }>(created);
    expect(chat).toMatchObject({ projectId: 'demo', cwd: dir, mode: 'plan', state: 'idle' });
    const solo = await json<{ chat: Chat }>(await call('POST', '/chats', { projectId: null, cwd: dir, mode: 'auto' }));

    expect((await json<{ chats: Chat[] }>(await call('GET', '/chats'))).chats).toHaveLength(2);
    expect((await json<{ chats: Chat[] }>(await call('GET', '/chats?projectId=demo'))).chats.map((c) => c.id)).toEqual([chat.id]);
    expect((await json<{ chats: Chat[] }>(await call('GET', '/chats?projectId='))).chats.map((c) => c.id)).toEqual([solo.chat.id]);
    expect((await call('GET', '/chats?projectId=Con Espacios')).status).toBe(400);

    const patched = await call('PATCH', `/chats/${chat.id}`, { mode: 'auto', title: 'Tablero' });
    expect((await json<{ chat: Chat }>(patched)).chat).toMatchObject({ mode: 'auto', title: 'Tablero' });

    hold();
    const sent = await call('POST', `/chats/${chat.id}/messages`, { text: 'hola' });
    expect(sent.status).toBe(201);
    expect((await json<{ message: { role: string; text: string } }>(sent)).message).toMatchObject({ role: 'user', text: 'hola', mode: 'auto' });
    const busy = await call('POST', `/chats/${chat.id}/messages`, { text: 'otro' });
    expect(busy.status).toBe(409);
    expect((await json<{ error: { code: string } }>(busy)).error.code).toBe('conflict');
    const stop = await call('POST', `/chats/${chat.id}/interrupt`);
    expect(stop.status).toBe(200);
    expect(q.interrupted).toBe(1);
    await idle(chat.id);

    await call('POST', `/chats/${chat.id}/messages`, { text: 'segundo' });
    release();
    await idle(chat.id);
    const { messages } = await json<{ messages: { role: string; text: string }[] }>(await call('GET', `/chats/${chat.id}/messages`));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect((await json<{ messages: unknown[] }>(await call('GET', `/chats/${chat.id}/messages?limit=1`))).messages).toHaveLength(1);
    // La respuesta llegó por el hub (/ws).
    expect(published.some((m) => m.type === 'event' && m.event.sessionId === chat.sessionId)).toBe(true);
    expect(published.filter((m) => m.type === 'chat_message')).toHaveLength(4);

    expect((await json<{ chat: Chat }>(await call('POST', `/chats/${chat.id}/close`))).chat.state).toBe('closed');
    const del = await call('DELETE', `/chats/${chat.id}`);
    expect(await json(del)).toEqual({ deleted: true, id: chat.id });
    expect((await call('GET', `/chats/${chat.id}`)).status).toBe(404);
    expect(published.some((m) => m.type === 'chat_deleted' && m.chatId === chat.id)).toBe(true);
  });

  it('valida entradas y exige el token', async () => {
    expect((await call('POST', '/chats', { projectId: 'no-existe' })).status).toBe(404);
    expect((await call('POST', '/chats', { projectId: null })).status).toBe(400);
    expect((await call('POST', '/chats', { projectId: 'demo', extra: 1 })).status).toBe(400);
    const { chat } = await json<{ chat: Chat }>(await call('POST', '/chats', { projectId: 'demo' }));
    expect((await call('POST', `/chats/${chat.id}/messages`, { text: '   ' })).status).toBe(400);
    expect((await call('GET', '/chats/corto')).status).toBe(400);
    expect((await call('GET', '/chats/no-existe-este-chat')).status).toBe(404);
    const res = await core.app.request(`http://${HOST}/chats`, { headers: { host: HOST } });
    expect(res.status).toBe(401);
    // El tope global de 1 MB sigue en las demás rutas.
    const huge = await call('POST', '/chats', { projectId: 'demo', title: 'x'.repeat(1_100_000) });
    expect(huge.status).toBe(413);
  });
});

describe('rutas de propuestas', () => {
  it('listar, aprobar, rechazar y aprobar todo', async () => {
    const { chat } = await json<{ chat: Chat }>(await call('POST', '/chats', { projectId: 'demo' }));
    await call('POST', `/chats/${chat.id}/messages`, { text: 'plan' });
    await idle(chat.id);
    await service?.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'Objetivo, pasos, rutas, riesgos y verificación' });

    const list = await json<{ proposals: { task: { id: string }; approval: string }[] }>(await call('GET', `/chats/${chat.id}/proposals`));
    expect(list.proposals.map((p) => [p.task.id, p.approval])).toEqual([['api', 'proposed'], ['ui', 'proposed']]);

    const rejected = await json<{ proposals: { approval: string }[] }>(await call('POST', `/chats/${chat.id}/proposals/ui/reject`));
    expect(rejected.proposals.map((p) => p.approval)).toEqual(['proposed', 'rejected']);
    const approved = await json<{ delivered: string[]; failed: unknown[]; proposals: { approval: string }[] }>(await call('POST', `/chats/${chat.id}/proposals/api/approve`));
    expect(approved).toMatchObject({ delivered: ['api'], failed: [] });
    expect(store.getTask('api')?.state).toBe('ready');
    expect(ports.fleet.delegated.map((t) => t.id)).toEqual(['api']);
    expect((await call('POST', `/chats/${chat.id}/proposals/api/reject`)).status).toBe(409);
    expect((await call('POST', `/chats/${chat.id}/proposals/nada/approve`)).status).toBe(404);
    const all = await json<{ delivered: string[] }>(await call('POST', `/chats/${chat.id}/proposals/approve-all`));
    expect(all.delivered).toEqual([]);
    expect(published.filter((m) => m.type === 'proposals').length).toBeGreaterThanOrEqual(3);
  });
});

describe('rutas de adjuntos', () => {
  it('sube bytes crudos de más de 1 MB (tope propio de 20 MB) y los sirve', async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    big.set(PNG);
    const up = await call('POST', '/attachments?name=captura.png', big, { 'content-type': 'image/png' });
    expect(up.status).toBe(201);
    const { attachment } = await json<{ attachment: { id: string; kind: string; size: number; mime: string } }>(up);
    expect(attachment).toMatchObject({ kind: 'image', size: big.byteLength, mime: 'image/png' });

    const got = await call('GET', `/attachments/${attachment.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toMatch(/^inline/);
    expect(got.headers.get('content-security-policy')).toMatch(/sandbox/);
    // Comparar con Buffer.equals: el toEqual de Vitest con 2 millones de elementos tarda segundos.
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(big))).toBe(true);
  });

  it('rechaza más de 20 MB con 413 y sirve lo que no es imagen como descarga opaca', async () => {
    const tooBig = await call('POST', '/attachments?name=enorme.bin', new Uint8Array(MAX_ATTACHMENT_BYTES + 1), {
      'content-type': 'application/octet-stream',
      'content-length': String(MAX_ATTACHMENT_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);
    expect((await call('POST', '/attachments', new Uint8Array([1]))).status).toBe(400);

    const html = await json<{ attachment: { id: string; kind: string } }>(
      await call('POST', '/attachments?name=pagina.html', new TextEncoder().encode('<script>alert(1)</script>'), { 'content-type': 'text/html' }),
    );
    expect(html.attachment.kind).toBe('text');
    const served = await call('GET', `/attachments/${html.attachment.id}`);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call('GET', '/attachments/no-existe-123')).status).toBe(404);
  });

  it('por ruta: registra un archivo local y el mensaje lo nombra', async () => {
    const file = join(dir, 'notas.md');
    await writeFile(file, '# notas');
    const reg = await call('POST', '/attachments/by-path', { path: file });
    expect(reg.status).toBe(201);
    const { attachment } = await json<{ attachment: { id: string; source: string; path: string } }>(reg);
    expect(attachment).toMatchObject({ source: 'path', path: file });
    expect((await call('POST', '/attachments/by-path', { path: join(dir, 'falta.md') })).status).toBe(404);
    expect((await call('POST', '/attachments/by-path', { path: 'relativa.md' })).status).toBe(400);

    const { chat } = await json<{ chat: Chat }>(await call('POST', '/chats', { projectId: 'demo' }));
    const sent = await call('POST', `/chats/${chat.id}/messages`, { text: 'lee', attachmentIds: [attachment.id] });
    expect(sent.status).toBe(201);
    await idle(chat.id);
    expect(q.received.at(-1)?.message.content).toBe(`lee\n\nAdjuntos: ${file}`);
  });
});

describe('rutas del chat: límites de la imagen', () => {
  it('una imagen enorme da 413 con el motivo', async () => {
    const big = new Uint8Array(4 * 1024 * 1024);
    big.set(PNG);
    const { attachment } = await json<{ attachment: { id: string } }>(await call('POST', '/attachments?name=foto.png', big, { 'content-type': 'image/png' }));
    const { chat } = await json<{ chat: Chat }>(await call('POST', '/chats', { projectId: 'demo' }));
    const res = await call('POST', `/chats/${chat.id}/messages`, { text: 'mira', attachmentIds: [attachment.id] });
    expect(res.status).toBe(413);
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(/5 MB en base64/);
  });
});
