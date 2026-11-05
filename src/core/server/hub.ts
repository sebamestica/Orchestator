import { z } from 'zod';
import type { AgentEvent, ChangesTarget, Chat, ChatMessage, EventSink, Plugin, Proposal, QuotaSnapshot, Settings } from '../../shared/index.ts';
import type { AgentRecord, QuotaRecord, SqliteStore, TaskRecord } from '../store/index.ts';

/** Mensajes que el servidor envía por `/ws`. */
export type HubMessage =
  | { type: 'hello'; serverTime: string; version: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'quota'; quota: QuotaRecord }
  | { type: 'task'; task: TaskRecord }
  | { type: 'agent'; agent: AgentRecord }
  | { type: 'agent_deleted'; agentId: string }
  | { type: 'replay'; sessionId: string; events: AgentEvent[]; lastSeq: number; hasMore: boolean }
  | { type: 'pong' }
  | { type: 'error'; error: { code: string; message: string } }
  | F5HubMessage;

/** Mensajes de F5 (docs/plan/F5-INTERFAZ.md): ajustes, chats con la mente, propuestas y plugins. */
export type F5HubMessage =
  | { type: 'settings'; settings: Settings }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'proposals'; chatId: string; proposals: Proposal[] }
  | { type: 'plugin'; plugin: Plugin }
  /** Cambió el destino de los cambios del chat (`crear_tareas.destino`): `GET /chats/:id/target` daría lo mismo. */
  | { type: 'chat_target'; chatId: string; target: ChangesTarget };

/** Mensajes que acepta el servidor por `/ws` (validados con Zod). */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('replay'),
    sessionId: z.string().min(1).max(200),
    since: z.number().int().min(-1).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  z.strictObject({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type HubListener = (message: HubMessage) => void;

export type HubStore = Pick<SqliteStore, 'appendEvent' | 'recordQuota'>;

/**
 * Punto único por el que pasan los eventos en vivo: los guarda (tachados) en SQLite y los
 * retransmite a los clientes del WebSocket. Es el `EventSink` que recibe la orquestación.
 */
export class EventHub implements EventSink {
  private readonly store: HubStore;
  private readonly listeners = new Set<HubListener>();
  private readonly onListenerError: (err: unknown) => void;

  constructor(store: HubStore, opts: { onListenerError?: (err: unknown) => void } = {}) {
    this.store = store;
    this.onListenerError = opts.onListenerError ?? (() => undefined);
  }

  /** `EventSink`: guarda y retransmite. Un reenvío con el mismo `seq` no se retransmite. */
  append(event: AgentEvent): void {
    const stored = this.store.appendEvent(event);
    if (stored) this.emit({ type: 'event', event: stored });
  }

  publishQuota(snapshot: QuotaSnapshot): QuotaRecord {
    const quota = this.store.recordQuota(snapshot);
    this.emit({ type: 'quota', quota });
    return quota;
  }

  publishTask(task: TaskRecord): void {
    this.emit({ type: 'task', task });
  }

  publishAgent(agent: AgentRecord): void {
    this.emit({ type: 'agent', agent });
  }

  publishAgentDeleted(agentId: string): void {
    this.emit({ type: 'agent_deleted', agentId });
  }

  /** Mensajes de F5 (no se guardan: su estado vive en SQLite y se lee por REST). */
  publish(message: F5HubMessage): void {
    this.emit(message);
  }

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  private emit(message: HubMessage): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }
}
