/**
 * Banco de pruebas del almacenamiento: SQLite en un archivo real (WAL y VACUUM de verdad), app real (`createApp`) con
 * las rutas del chat (`ChatService` con la `query` falsa del SDK) y las del almacenamiento, reloj controlado y
 * carpetas temporales: datos, `berland-conversaciones`, un proyecto y la bóveda. Nunca toca datos del usuario.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkTranslator } from '../../../src/core/adapters/claude-sdk/index.ts';
import { AttachmentStore, ChatService, registerChatRoutes } from '../../../src/core/chat/index.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, type CoreApp, type RouteModuleContext } from '../../../src/core/server/index.ts';
import { createStorageRoutes, type StorageRoutesOptions } from '../../../src/core/storage-stats/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { createUsageRoutes } from '../../../src/core/usage-stats/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { DEFAULT_SETTINGS } from '../../../src/shared/index.ts';
import type { AgentEvent, Chat } from '../../../src/shared/index.ts';
import { fakePorts } from '../conductor/fakes.ts';
import { MIND_KEY, chatQuery, claudeAgent, sdkInit, sdkResult, sdkText, type TurnContext } from '../chat/helpers.ts';

export const HOST = '127.0.0.1:47998';
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

let n = 0;
const uuid = () => `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`;

/** Aviso del SDK: la mente lanzó un subagente en segundo plano. */
function taskStarted(taskId: string, toolUseId: string, sid: string): SDKMessage {
  return { type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'Investigar', subagent_type: 'general-purpose', session_id: sid, uuid: uuid() } as unknown as SDKMessage;
}

export interface StorageBench {
  dir: string;
  dataDir: string;
  dbPath: string;
  convRoot: string;
  /** Carpeta del proyecto `demo` (nunca se toca). */
  repo: string;
  vaultPath: string;
  store: SqliteStore;
  core: CoreApp;
  clock: { now: Date };
  service: ChatService | undefined;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = Record<string, unknown>>(res: Response): Promise<T>;
  /** Deja el próximo turno de la mente esperando hasta `release()`. */
  hold(): void;
  release(): void;
  /** Crea un chat del proyecto `demo` y, si se pide, le envía un mensaje y espera a que termine. */
  chat(text?: string, attachmentIds?: string[]): Promise<Chat>;
  idle(chatId: string): Promise<void>;
  upload(name: string, bytes: Uint8Array, mime?: string): Promise<{ id: string; path: string; size: number }>;
  /** Eventos de relleno en una sesión (para que la base pese). */
  seed(sessionId: string, count: number, opts?: { parentSessionId?: string; agentId?: string; textBytes?: number }): void;
  close(): Promise<void>;
}

export interface BenchOptions {
  /** Sin las rutas del chat (como la app de la documentación). */
  noChat?: boolean;
  storage?: Partial<StorageRoutesOptions>;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

export async function storageBench(opts: BenchOptions = {}): Promise<StorageBench> {
  const dir = await mkdtemp(join(tmpdir(), 'orq-almacen-'));
  const dataDir = join(dir, 'orquestador');
  const dbPath = join(dataDir, 'orquestador.db');
  const convRoot = join(dir, 'berland-conversaciones');
  const repo = join(dir, 'proyecto');
  const vaultPath = join(dataDir, 'vault.json');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'README.md'), '# Proyecto del usuario\n');
  const store = new SqliteStore({ path: dbPath });
  store.putProject({ id: 'demo', name: 'Demo', repoPath: repo });
  await writeFile(vaultPath, '{"version":1,"secrets":{}}');
  const hub = new EventHub(store);
  const registry = new AgentRegistry({ store, vault: new MemoryVault(), detectors: [] });
  const clock = { now: new Date() };
  let gate = Promise.resolve();
  let release: () => void = () => undefined;
  const q = chatQuery(async (m: SDKUserMessage, ctx: TurnContext) => {
    await Promise.race([gate, ctx.stopped]);
    const sid = typeof ctx.options.resume === 'string' ? ctx.options.resume : `sdk-${ctx.process}`;
    const content = m.message.content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const first = ctx.index === 0 ? [sdkInit(sid)] : [];
    if (text.includes('investiga')) return [...first, sdkText('Lanzo un investigador.', sid), taskStarted('t1', 'tu1', sid), sdkResult('Lanzo un investigador.', sid, 0.01)];
    return [...first, sdkText(`eco: ${text}`, sid), sdkResult(`eco: ${text}`, sid, 0.01 * (ctx.index + 1))];
  });
  const token = generateToken();
  const b: StorageBench = {
    dir,
    dataDir,
    dbPath,
    convRoot,
    repo,
    vaultPath,
    store,
    core: undefined as unknown as CoreApp,
    clock,
    service: undefined,
    call(method, path, body, headers = {}) {
      const init: RequestInit = { method, headers: { host: HOST, authorization: `Bearer ${token}`, ...headers } };
      if (body instanceof Uint8Array) init.body = body;
      else if (body !== undefined) {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)['content-type'] = 'application/json';
      }
      return Promise.resolve(b.core.app.request(`http://${HOST}${path}`, init));
    },
    async json<T>(res: Response) {
      return (await res.json()) as T;
    },
    hold() {
      gate = new Promise((r) => {
        release = r;
      });
    },
    release() {
      release();
    },
    async chat(text, attachmentIds = []) {
      const res = await b.call('POST', '/chats', { projectId: 'demo' });
      const { chat } = await b.json<{ chat: Chat }>(res);
      if (text !== undefined) {
        const sent = await b.call('POST', `/chats/${chat.id}/messages`, { text, attachmentIds });
        if (sent.status !== 201) throw new Error(`mensaje: ${sent.status} ${await sent.text()}`);
        await b.idle(chat.id);
      }
      return chat;
    },
    async idle(chatId) {
      for (let i = 0; i < 600; i++) {
        const { chat } = await b.json<{ chat: Chat }>(await b.call('GET', `/chats/${chatId}`));
        if (chat.state !== 'running') {
          await tick();
          return;
        }
        await tick();
      }
      throw new Error(`el chat ${chatId} sigue running`);
    },
    async upload(name, bytes, mime = 'application/octet-stream') {
      const res = await b.call('POST', `/attachments?name=${encodeURIComponent(name)}`, bytes, { 'content-type': mime });
      if (res.status !== 201) throw new Error(`subida: ${res.status} ${await res.text()}`);
      return (await b.json<{ attachment: { id: string; path: string; size: number } }>(res)).attachment;
    },
    seed(sessionId, count, o = {}) {
      const line = 'palabra de relleno para que la base pese algo de verdad '.repeat(Math.ceil((o.textBytes ?? 1500) / 57)).slice(0, o.textBytes ?? 1500);
      const last = store.getSession(sessionId)?.lastSeq ?? -1;
      for (let i = 1; i <= count; i++) {
        const event: AgentEvent = {
          type: 'text',
          sessionId,
          agentId: o.agentId ?? 'orquestador',
          seq: last + i,
          ts: new Date(clock.now.getTime() + i).toISOString(),
          payload: { role: 'assistant', text: `${i} ${line}` },
          ...(o.parentSessionId ? { parentSessionId: o.parentSessionId } : {}),
        };
        store.append(event);
      }
    },
    async close() {
      b.service?.shutdown();
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  const ports = fakePorts();
  b.core = createApp({
    token,
    allowedHosts: () => [HOST],
    store,
    registry,
    hub,
    now: () => clock.now,
    validateResponses: true,
    routeModules: [
      ...(opts.noChat
        ? []
        : [
            (ctx: RouteModuleContext) => {
              const attachments = new AttachmentStore({ db: ctx.store.database, dir: join(dataDir, 'attachments'), now: ctx.now });
              b.service = new ChatService({
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
                now: ctx.now,
              });
              registerChatRoutes(ctx, { service: b.service, attachments });
            },
          ]),
      createUsageRoutes({ mindAgentId: 'orquestador' }),
      createStorageRoutes({ dataDir, dbPath, protectedPaths: () => [vaultPath], ...opts.storage }),
    ],
  });
  return b;
}

/** Pone la fecha de modificación en el pasado (lo reciente no se vacía). */
export async function age(p: string, ms = 2 * HOUR): Promise<void> {
  const t = new Date(Date.now() - ms);
  await utimes(p, t, t);
}

/** Escribe un archivo de `bytes` bytes (creando sus carpetas). */
export async function fill(p: string, bytes: number): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, new Uint8Array(bytes).fill(0x61));
}
