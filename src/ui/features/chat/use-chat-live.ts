/**
 * Conexión de la vista de chat con `/ws`: los `event` de la sesión de la mente se agrupan por cuadro
 * (`requestAnimationFrame`) antes de tocar el estado; al montar y al reconectar se pide `replay` desde el
 * último `seq` visto (y se recargan chat, mensajes y propuestas por si algo se perdió). Sin nada visto, solo
 * se pide la cola que se muestra (`MAX_SESSION_EVENTS`), no toda la historia de la sesión.
 */
import { useEffect } from 'react';
import { z } from 'zod';
import type { AgentEvent } from '../../../shared/index.ts';
import { api } from '../../api/client.ts';
import { getLive } from '../../api/live.ts';
import { useChat } from './store.ts';
import { MAX_SESSION_EVENTS } from './timeline.ts';

type FrameHandle = { cancel(): void };

function onNextFrame(cb: () => void): FrameHandle {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb());
    return { cancel: () => cancelAnimationFrame(id) };
  }
  const id = setTimeout(cb, 16);
  return { cancel: () => clearTimeout(id) };
}

const sessionTailSchema = z.object({ session: z.object({ lastSeq: z.number().int().min(-1) }) });

/** `since` para traer solo los últimos `MAX_SESSION_EVENTS` de la sesión; sin sesión aún (404), desde el principio. */
async function tailSince(sessionId: string): Promise<number> {
  try {
    const { session } = sessionTailSchema.parse(await api.get<unknown>(`/sessions/${encodeURIComponent(sessionId)}`));
    return Math.max(-1, session.lastSeq - MAX_SESSION_EVENTS);
  } catch {
    return -1;
  }
}

export function useChatLive(sessionId: string | null): void {
  useEffect(() => {
    const live = getLive();
    if (!live) return;
    let buffer: AgentEvent[] = [];
    let frame: FrameHandle | null = null;
    const flush = () => {
      frame = null;
      const batch = buffer;
      buffer = [];
      useChat.getState().ingest(batch);
    };
    const queue = (events: readonly AgentEvent[]) => {
      if (events.length === 0) return;
      buffer.push(...events);
      frame ??= onNextFrame(flush);
    };

    let stopped = false;
    // Mayor `since` pedido por esta suscripción (`null`: ninguno aún). Una página solo encadena la siguiente si
    // avanza más allá: una cadena vieja o una página repetida se apaga sola.
    let highest: number | null = null;
    const ask = (id: string, since: number) => {
      highest = Math.max(highest ?? since, since);
      live.replay(id, since);
    };
    // Al abrir o reconectar arranca una cadena nueva: lo pedido por un socket anterior ya no va a llegar.
    const requestReplay = (id: string) => {
      highest = null;
      const seen = useChat.getState().lastSeq;
      if (seen >= 0) {
        ask(id, seen);
        return;
      }
      void tailSince(id).then((since) => {
        if (!stopped) ask(id, since);
      });
    };

    const offMessages = live.subscribe((message) => {
      switch (message.type) {
        case 'event':
          if (sessionId && message.event.sessionId === sessionId) queue([message.event]);
          return;
        case 'replay':
          if (!sessionId || message.sessionId !== sessionId) return;
          queue(message.events);
          if (message.hasMore && highest !== null && message.lastSeq > highest) ask(sessionId, message.lastSeq);
          return;
        default:
          useChat.getState().applyLive(message);
      }
    });
    const offStatus = live.onStatus((status) => {
      if (status !== 'open' || !sessionId) return;
      requestReplay(sessionId);
      void useChat.getState().refresh();
    });
    if (sessionId && live.status === 'open') requestReplay(sessionId);

    return () => {
      stopped = true;
      offMessages();
      offStatus();
      frame?.cancel();
      frame = null;
      buffer = [];
    };
  }, [sessionId]);
}
