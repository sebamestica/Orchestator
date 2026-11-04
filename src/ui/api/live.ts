/**
 * Conexión en vivo con el núcleo (`/ws`). El navegador no puede mandar `Authorization` en el handshake:
 * el token va como subprotocolo `orq.bearer.<token>` junto a `orq` (el núcleo responde `orq`).
 * Reconecta sola con espera creciente. Un solo socket para toda la interfaz.
 */
import type { AgentEvent, Chat, ChatMessage, Plugin, Proposal, Settings } from '../../shared/index.ts';
import type { CoreEndpoint } from './bridge.ts';
import type { AgentRecord, QuotaRecord, TaskRecord } from './types.ts';

export type LiveMessage =
  | { type: 'hello'; serverTime: string; version: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'quota'; quota: QuotaRecord }
  | { type: 'task'; task: TaskRecord }
  | { type: 'agent'; agent: AgentRecord }
  | { type: 'agent_deleted'; agentId: string }
  | { type: 'replay'; sessionId: string; events: AgentEvent[]; lastSeq: number; hasMore: boolean }
  | { type: 'pong' }
  | { type: 'error'; error: { code: string; message: string } }
  | { type: 'settings'; settings: Settings }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'proposals'; chatId: string; proposals: Proposal[] }
  | { type: 'plugin'; plugin: Plugin };

export type LiveStatus = 'connecting' | 'open' | 'closed';
type Listener = (message: LiveMessage) => void;
type StatusListener = (status: LiveStatus) => void;

export const LIVE_PROTOCOL = 'orq';
export const bearerProtocol = (token: string) => `orq.bearer.${token}`;

export class LiveConnection {
  readonly #listeners = new Set<Listener>();
  readonly #statusListeners = new Set<StatusListener>();
  #socket: WebSocket | null = null;
  #status: LiveStatus = 'closed';
  #retry = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  readonly #core: CoreEndpoint;
  readonly #make: (url: string, protocols: string[]) => WebSocket;

  constructor(core: CoreEndpoint, make: (url: string, protocols: string[]) => WebSocket = (u, p) => new WebSocket(u, p)) {
    this.#core = core;
    this.#make = make;
  }

  get status(): LiveStatus {
    return this.#status;
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#socket?.close();
    this.#socket = null;
    this.#setStatus('closed');
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** Pide los eventos de una sesión desde `since` (llegan como `replay`). */
  replay(sessionId: string, since = -1, limit = 500): void {
    this.#send({ type: 'replay', sessionId, since, limit });
  }

  #send(message: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #setStatus(status: LiveStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    for (const l of this.#statusListeners) l(status);
  }

  #open(): void {
    if (this.#stopped) return;
    this.#setStatus('connecting');
    const socket = this.#make(this.#core.wsUrl, [LIVE_PROTOCOL, bearerProtocol(this.#core.token)]);
    this.#socket = socket;
    socket.onopen = () => {
      this.#retry = 0;
      this.#setStatus('open');
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let message: LiveMessage;
      try {
        message = JSON.parse(ev.data) as LiveMessage;
      } catch {
        return;
      }
      for (const l of this.#listeners) l(message);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#setStatus('closed');
      if (this.#stopped) return;
      const wait = Math.min(15_000, 500 * 2 ** this.#retry++);
      this.#timer = setTimeout(() => this.#open(), wait);
    };
  }
}

let live: LiveConnection | null = null;

export function startLive(core: CoreEndpoint): LiveConnection {
  live?.stop();
  live = new LiveConnection(core);
  live.start();
  return live;
}

export function getLive(): LiveConnection | null {
  return live;
}
