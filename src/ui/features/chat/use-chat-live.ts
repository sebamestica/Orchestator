/**
 * Conexión de la vista de chat con `/ws`: los `event` de la sesión de la mente se agrupan por cuadro
 * (`requestAnimationFrame`) antes de tocar el estado; al montar y al reconectar se pide `replay` desde el
 * último `seq` visto (y se recargan chat, mensajes y propuestas por si algo se perdió).
 */
import { useEffect } from 'react';
import type { AgentEvent } from '../../../shared/index.ts';
import { getLive } from '../../api/live.ts';
import { useChat } from './store.ts';

type FrameHandle = { cancel(): void };

function onNextFrame(cb: () => void): FrameHandle {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb());
    return { cancel: () => cancelAnimationFrame(id) };
  }
  const id = setTimeout(cb, 16);
  return { cancel: () => clearTimeout(id) };
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

    const offMessages = live.subscribe((message) => {
      switch (message.type) {
        case 'event':
          if (sessionId && message.event.sessionId === sessionId) queue([message.event]);
          return;
        case 'replay':
          if (!sessionId || message.sessionId !== sessionId) return;
          queue(message.events);
          if (message.hasMore) live.replay(sessionId, message.lastSeq);
          return;
        default:
          useChat.getState().applyLive(message);
      }
    });
    const offStatus = live.onStatus((status) => {
      if (status !== 'open' || !sessionId) return;
      live.replay(sessionId, useChat.getState().lastSeq);
      void useChat.getState().refresh();
    });
    if (sessionId && live.status === 'open') live.replay(sessionId, useChat.getState().lastSeq);

    return () => {
      offMessages();
      offStatus();
      frame?.cancel();
      frame = null;
      buffer = [];
    };
  }, [sessionId]);
}
