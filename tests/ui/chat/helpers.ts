/**
 * Dobles de prueba de la vista de chat: núcleo REST en memoria (fetch simulado), conexión en vivo
 * simulada (`getLive`) y datos de ejemplo. Los usan los `*.test.tsx` de esta carpeta.
 */
import { vi } from 'vitest';
import type { AgentEvent, Attachment, Chat, ChatMessage, Proposal } from '../../../src/shared/index.ts';
import { DEFAULT_SETTINGS } from '../../../src/shared/api.ts';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import type { AgentRecord, ProjectRecord } from '../../../src/ui/api/types.ts';
import { useApp } from '../../../src/ui/store/app.ts';
import { useChat } from '../../../src/ui/features/chat/store.ts';

export const CORE = { url: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: 'k'.repeat(43) };
export const T0 = Date.parse('2026-11-04T12:00:00.000Z');
export const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

export function makeChat(over: Partial<Chat> = {}): Chat {
  return {
    id: 'chat_abc123',
    projectId: 'demo',
    title: 'Primera conversación',
    cwd: 'C:\\dev\\demo',
    extraRoots: [],
    mode: 'plan',
    mindAgentId: 'claude',
    sessionId: 'sess_chat_1',
    state: 'idle',
    costUsd: 0.12,
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  };
}

export function makeMessage(over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'text'>): ChatMessage {
  return { chatId: 'chat_abc123', attachments: [], mode: 'plan', at: at(0), ...over };
}

export function makeAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att_img001',
    name: 'captura.png',
    mime: 'image/png',
    size: 2048,
    path: 'C:\\datos\\captura.png',
    kind: 'image',
    source: 'upload',
    createdAt: at(0),
    ...over,
  };
}

export function makeProposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    task: {
      id,
      projectId: 'demo',
      title: `Tarea ${id}`,
      objective: `Objetivo de **${id}**`,
      ownedPaths: [`src/${id}/**`],
      dependsOn: [],
      acceptance: [`Criterio de ${id}`],
      difficulty: 'medium',
      suggestedAgent: 'codex',
      contextRefs: [],
      skillRefs: [],
    },
    approval: 'proposed',
    proposedAt: at(5),
    ...over,
  };
}

const base = (seq: number, sec: number) => ({ sessionId: 'sess_chat_1', agentId: 'claude', seq, ts: at(sec) });
export const ev = {
  text: (seq: number, sec: number, text: string): AgentEvent => ({ ...base(seq, sec), type: 'text', payload: { text, role: 'assistant' } }),
  thinking: (seq: number, sec: number, text: string): AgentEvent => ({ ...base(seq, sec), type: 'text', payload: { text, role: 'thinking-summary' } }),
  call: (seq: number, sec: number, callId: string, name: string, inputSummary: string): AgentEvent => ({ ...base(seq, sec), type: 'tool_call', payload: { callId, name, inputSummary } }),
  result: (seq: number, sec: number, callId: string, ok: boolean, summary: string): AgentEvent => ({ ...base(seq, sec), type: 'tool_result', payload: { callId, ok, summary } }),
  usage: (seq: number, sec: number, inputTokens: number, outputTokens: number, costUsd?: number, model = 'claude-opus-5-5'): AgentEvent => ({
    ...base(seq, sec),
    type: 'usage',
    payload: { inputTokens, outputTokens, model, ...(costUsd !== undefined ? { costUsd } : {}) },
  }),
  done: (seq: number, sec: number): AgentEvent => ({ ...base(seq, sec), type: 'done', payload: { ok: true } }),
  error: (seq: number, sec: number, message: string): AgentEvent => ({ ...base(seq, sec), type: 'error', payload: { code: 'unknown', message } }),
  status: (seq: number, sec: number, detail: string): AgentEvent => ({ ...base(seq, sec), type: 'status', payload: { state: 'running', detail } }),
};

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

export type Reply = { status?: number; body?: unknown; raw?: BodyInit; contentType?: string } | undefined;
export type Handler = (method: string, path: string, body: unknown) => Reply;

export const NOT_FOUND_ROUTE: Reply = { status: 404, body: { error: { code: 'not_found', message: 'Ruta no encontrada' } } };

/** `fetch` simulado: registra cada llamada y responde con `handler` (sin respuesta: 404 de ruta). */
export function installFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, path, body, headers: new Headers(init?.headers) });
    const r = handler(method, path, body) ?? NOT_FOUND_ROUTE;
    const payload = r?.raw ?? (r?.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(payload, { status: r?.status ?? 200, headers: { 'Content-Type': r?.contentType ?? 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export interface CoreState {
  chats: Chat[];
  messages: Record<string, ChatMessage[]>;
  proposals: Record<string, Proposal[]>;
}

/**
 * Aprueba y entrega como `approveAndDeliver`: queda `delegated` si sus dependencias ya lo están; si no, sigue
 * `approved` y va en `failed` con el mismo motivo que da el núcleo.
 */
function approveIn(state: CoreState, chatId: string, ids: readonly string[]) {
  const delivered: string[] = [];
  const failed: { taskId: string; reason: string }[] = [];
  for (const taskId of ids) {
    const list = state.proposals[chatId] ?? [];
    const task = list.find((x) => x.task.id === taskId)?.task;
    if (!task) continue;
    const missing = task.dependsOn.filter((d) => list.find((x) => x.task.id === d)?.approval !== 'delegated');
    const approval = missing.length ? 'approved' : 'delegated';
    state.proposals[chatId] = list.map((x) => (x.task.id === taskId ? { ...x, approval } : x));
    if (missing.length) failed.push({ taskId, reason: `depende de ${missing.join(', ')}, que aún no está en la flota: apruébala antes` });
    else delivered.push(taskId);
  }
  return { proposals: state.proposals[chatId] ?? [], delivered, failed };
}

/** Núcleo con `/chats` (como lo hará c15) en memoria; aprobar responde `{ proposals, delivered, failed }`. */
export function fakeCore(init: Partial<CoreState> = {}, extra?: Handler): { state: CoreState; calls: Call[] } {
  const state: CoreState = { chats: init.chats ?? [], messages: init.messages ?? {}, proposals: init.proposals ?? {} };
  let seq = 0;
  const calls = installFetch((method, path, body) => {
    const fromExtra = extra?.(method, path, body);
    if (fromExtra) return fromExtra;
    const [p = ''] = path.split('?');
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (p === '/chats' && method === 'GET') return { body: { chats: state.chats } };
    if (p === '/chats' && method === 'POST') {
      const id = `chat_new00${++seq}`;
      // Como el núcleo: una conversación sin proyecto ni carpeta recibe una carpeta interna.
      const internal = b.projectId === null && b.cwd === undefined;
      const chat = makeChat({
        id,
        projectId: (b.projectId as string | null) ?? null,
        title: '',
        mode: (b.mode as Chat['mode']) ?? 'plan',
        cwd: internal ? `C:\\Users\\yo\\AppData\\Local\\berland-conversaciones\\${id}` : ((b.cwd as string) ?? 'C:\\dev\\demo'),
        ...(internal ? { internalFolder: true as const } : {}),
        extraRoots: (b.extraRoots as string[]) ?? [],
        sessionId: `sess_new_${seq}`,
        costUsd: 0,
        updatedAt: at(100 + seq),
      });
      state.chats.push(chat);
      return { body: { chat } };
    }
    if ((m = /^\/chats\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1] ?? '');
      const i = state.chats.findIndex((c) => c.id === id);
      const chat = state.chats[i];
      if (!chat) return { status: 404, body: { error: { code: 'not_found', message: `No existe el chat ${id}` } } };
      if (method === 'GET') return { body: { chat } };
      if (method === 'PATCH') {
        const next = { ...chat, ...b } as Chat;
        state.chats[i] = next;
        return { body: { chat: next } };
      }
      if (method === 'DELETE') {
        state.chats.splice(i, 1);
        return { body: { deleted: true, id } };
      }
    }
    if ((m = /^\/chats\/([^/]+)\/messages$/.exec(p))) {
      const id = decodeURIComponent(m[1] ?? '');
      if (method === 'GET') return { body: { messages: state.messages[id] ?? [] } };
      const message = makeMessage({ id: `msg_user_${++seq}`, chatId: id, role: 'user', text: String(b.text ?? ''), at: at(200 + seq) });
      state.messages[id] = [...(state.messages[id] ?? []), message];
      return { body: { message } };
    }
    if ((m = /^\/chats\/([^/]+)\/interrupt$/.exec(p))) return { body: { ok: true } };
    if ((m = /^\/chats\/([^/]+)\/proposals$/.exec(p))) return { body: { proposals: state.proposals[decodeURIComponent(m[1] ?? '')] ?? [] } };
    if ((m = /^\/chats\/([^/]+)\/proposals\/approve-all$/.exec(p))) {
      const id = decodeURIComponent(m[1] ?? '');
      const ids = (state.proposals[id] ?? []).filter((x) => x.approval === 'proposed' || x.approval === 'approved').map((x) => x.task.id);
      return { body: approveIn(state, id, ids) };
    }
    if ((m = /^\/chats\/([^/]+)\/proposals\/([^/]+)\/approve$/.exec(p))) {
      return { body: approveIn(state, decodeURIComponent(m[1] ?? ''), [decodeURIComponent(m[2] ?? '')]) };
    }
    if ((m = /^\/chats\/([^/]+)\/proposals\/([^/]+)\/reject$/.exec(p))) {
      const id = decodeURIComponent(m[1] ?? '');
      const task = decodeURIComponent(m[2] ?? '');
      state.proposals[id] = (state.proposals[id] ?? []).map((x) => (x.task.id === task ? { ...x, approval: 'rejected' } : x));
      return { body: { proposals: state.proposals[id] } };
    }
    return undefined;
  });
  return { state, calls };
}

export const PROJECT: ProjectRecord = { id: 'demo', name: 'Demo', repoPath: 'C:\\dev\\demo', createdAt: at(0) };

function agent(id: string, kind: AgentRecord['config']['kind'], displayName: string): AgentRecord {
  return {
    config: { id, kind, provider: kind === 'claude-sdk' ? 'anthropic' : 'openai', displayName, quotaFloor: 0.2, enabled: true },
    quotaMethod: null,
    lastProbe: null,
    createdAt: at(0),
    updatedAt: at(0),
  };
}

/** Estado global mínimo (núcleo listo, un proyecto y dos agentes) y estado del chat limpio. */
export function setupApp(): void {
  setCoreEndpoint(CORE);
  useApp.setState({
    core: 'ready',
    projects: [PROJECT],
    agents: [agent('claude', 'claude-sdk', 'Claude'), agent('codex', 'codex-cli', 'Codex')],
    settings: DEFAULT_SETTINGS,
  });
  useChat.getState().reset();
  window.history.replaceState(null, '', '/#/p/demo');
}
