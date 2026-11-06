import { useEffect, useState, type KeyboardEvent } from 'react';
import { api } from '../../api/client.ts';
import { getLive } from '../../api/live.ts';
import { useApp } from '../../store/app.ts';
import type { Chat } from '../../../shared/api.ts';
import { upsertChat, useChat } from '../chat/store.ts';
import { ActivityRowView } from './ActivityRowView.tsx';
import { applyEvents, chatsSchema, initialView, isActive, mindRow, selectChat, sessionResponseSchema, sessionsSchema, workerRow, type SessionView } from './model.ts';

const PLACEMENT = {
  inline: 'flex shrink-0',
  // Ventana angosta: encima del contenido, sin encogerlo. `chrome-frame` deja 0.5rem a la derecha y abajo.
  overlay: 'absolute top-0 right-2 bottom-2 z-30 flex max-w-[calc(100%-1rem)] shadow-xl',
};

/** Panel de agentes en vivo. `overlay`: superpuesto (ventana angosta); Escape lo cierra con `onClose`. */
export function AgentsPanel({ overlay = false, onClose }: { overlay?: boolean; onClose?: () => void }) {
  const core = useApp((s) => s.core);
  const connection = useApp((s) => s.live);
  const agents = useApp((s) => s.agents);
  const tasks = useApp((s) => s.tasks);
  const quotas = useApp((s) => s.quotas);
  // Lista propia de todos los chats: la de `useChat` es de la vista abierta (filtrada por carpeta y vacía al salir).
  const [chats, setChats] = useState<Chat[]>([]);
  const opened = useChat((s) => s.chat);
  const events = useChat((s) => s.events);
  const chat = selectChat(chats, opened);
  const [views, setViews] = useState<Record<string, SessionView>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  // El contrato permite filtrar por tarea, pero todavía no por estado.
  const taskIds = Object.values(tasks).filter((task) => ['running', 'review'].includes(task.state)).map((task) => task.task.id).sort().join(',');

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (core !== 'ready') return;
    setViews({});
    return getLive()?.subscribe((message) => {
      if (message.type === 'chat') setChats((current) => upsertChat(current, message.chat));
      if (message.type === 'chat_deleted') setChats((current) => current.filter((item) => item.id !== message.chatId));
      if (message.type === 'event' || message.type === 'replay') {
        setViews((current) => applyEvents(current, message.type === 'event' ? [message.event] : message.events));
      }
    });
  }, [core, connection]);

  useEffect(() => {
    if (core !== 'ready' || connection !== 'open') return;
    let stopped = false;
    void api.get<unknown>('/chats')
      .then((data) => { if (!stopped) setChats(chatsSchema.parse(data).chats); })
      .catch(() => { /* Sin la lista, la fila sigue al chat abierto. */ });
    return () => { stopped = true; };
  }, [core, connection]);

  useEffect(() => {
    if (core !== 'ready' || connection !== 'open') return;
    let stopped = false;
    setNotice(null);
    const live = getLive();
    function merge(sessions: SessionView['session'][]) {
      if (stopped) return;
      setViews((current) => {
        const next = { ...current };
        for (const session of sessions) {
          const previous = next[session.id];
          next[session.id] = previous ? { ...previous, session: previous.latest && previous.latest.seq > session.lastSeq
            ? { ...session, state: previous.session.state, updatedAt: previous.session.updatedAt, lastSeq: previous.session.lastSeq } : session } : initialView(session);
        }
        return next;
      });
      for (const session of sessions) {
        if (isActive(initialView(session))) live?.replay(session.id, Math.max(-1, session.lastSeq - 1), 1);
      }
    }
    for (const taskId of taskIds.split(',').filter(Boolean)) {
      // Las revisiones usan actualmente <taskId>-revision.
      for (const id of [taskId, `${taskId}-revision`]) {
        void api.get<unknown>(`/sessions?taskId=${encodeURIComponent(id)}&limit=10`)
          .then((data) => merge(sessionsSchema.parse(data).sessions.filter((session) => isActive(initialView(session)))))
          .catch(() => { if (!stopped) setNotice('No se pudo consultar la actividad de los agentes.'); });
      }
    }
    if (chat && (chat.state === 'running' || (chat.backgroundTasks ?? 0) > 0)) {
      void api.get<unknown>(`/sessions/${encodeURIComponent(chat.sessionId)}`)
        .then((data) => merge([sessionResponseSchema.parse(data).session]))
        .catch(() => { /* La sesión de un chat recién creado puede no existir aún. */ });
      void api.get<unknown>(`/sessions?parentSessionId=${encodeURIComponent(chat.sessionId)}&limit=1000`)
        .then((data) => merge(sessionsSchema.parse(data).sessions.filter((session) => isActive(initialView(session)))))
        .catch(() => { if (!stopped) setNotice('No se pudo consultar la actividad en segundo plano.'); });
    }
    return () => { stopped = true; };
  }, [core, connection, taskIds, chat?.sessionId, chat?.state, chat?.backgroundTasks]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!overlay || event.key !== 'Escape') return;
    event.preventDefault(); // Que el composer no lo tome como «detener la mente».
    onClose?.();
  }

  return <aside aria-label="Agentes en vivo" data-overlay={overlay ? '' : undefined} onKeyDown={onKeyDown}
    className={`chrome-surface ${overlay ? PLACEMENT.overlay : PLACEMENT.inline} w-[var(--panel-width)] flex-col overflow-hidden`}>
    <header className="border-b border-foreground/[0.06] px-4 py-3"><h2 className="text-sm font-medium">Agentes</h2></header>
    {/* Una sola parada de Tab para desplazar la lista con el teclado; las filas no se enfocan. */}
    <div role="group" aria-label="Lista de agentes" tabIndex={0}
      className="flex-1 space-y-2 overflow-y-auto p-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground">
      <ActivityRowView name="Mente" row={mindRow(chat, views, events)} />
      {connection !== 'open' && <p role="status" className="px-3 text-xs text-muted">Sin conexión en vivo</p>}
      {notice && <p role="status" className="px-3 text-xs text-amber-600 dark:text-amber-400">{notice}</p>}
      <div className="space-y-1 border-t border-foreground/[0.06] pt-2">
        {agents.filter((agent) => agent.config.enabled).map((agent) => {
          const id = agent.config.id;
          const low = quotas[id]?.snapshot.buckets.reduce<number | null>((min, bucket) => bucket.remainingFraction === null ? min : Math.min(min ?? 1, bucket.remainingFraction), null);
          return <ActivityRowView key={id} name={agent.config.displayName} row={workerRow(id, views, tasks, now)}
            quota={low != null && low < 0.1 ? `Cupo bajo: ${Math.floor(low * 100)} % restante` : undefined} />;
        })}
      </div>
    </div>
  </aside>;
}
