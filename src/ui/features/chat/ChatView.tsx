/**
 * Vista de chat con la mente (c19, docs/plan/F5-INTERFAZ.md §6): encabezado con proyecto y conversaciones,
 * hilo en Markdown con la respuesta en vivo desde `/ws`, propuestas aprobables, ficha del modo con
 * Shift+Tab y el Composer abajo, con el esfuerzo de razonamiento de cada chat (issue 10).
 */
import { Button, Spinner } from '@heroui/react';
import { ArrowDown, CircleAlert, MessageSquareOff, Unplug, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { effortSchema, nextMindMode, type Attachment, type Chat, type Effort, type MindMode } from '../../../shared/api.ts';
import { navigate } from '../../app/routes.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { useApp } from '../../store/app.ts';
import { Composer } from '../composer/Composer.tsx';
import { ChatHeader } from './components/ChatHeader.tsx';
import { EmptyChat } from './components/EmptyChat.tsx';
import { LiveReply } from './components/LiveReply.tsx';
import { MessageList } from './components/MessageList.tsx';
import { ModeChip } from './components/ModeChip.tsx';
import { ProposalsCard } from './components/ProposalsCard.tsx';
import { BackgroundLine } from './components/BackgroundLine.tsx';
import { TargetLine } from './components/TargetLine.tsx';
import { APP_NAME } from './format.ts';
import { attachFile, chosenEffort, effortIn, errorText, pickFolder, useChat } from './store.ts';
import { anchorProposals, buildReply, PROPOSALS_AT_END, splitTurns } from './timeline.ts';
import { useChatLive } from './use-chat-live.ts';

export interface ChatViewProps {
  projectId: string | null;
  chatId?: string;
}

const NEAR_BOTTOM_PX = 80;

/** Mantiene el hilo pegado al final mientras llega texto, salvo que el usuario haya subido. */
function useStickToBottom(signature: string) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const near = node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
    pinned.current = near;
    setAway(!near);
  }, []);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [signature]);
  const toLatest = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    pinned.current = true;
    setAway(false);
  }, []);
  return { ref, onScroll, away, toLatest };
}

/** Campo donde Shift+Tab es del propio campo (el Composer lo usa para el modo; los demás, para el foco). */
function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
}

export default function ChatView({ projectId, chatId }: ChatViewProps) {
  const project = useApp((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));
  const settings = useApp((s) => s.settings);
  const agents = useApp((s) => s.agents);

  const status = useChat((s) => s.status);
  const error = useChat((s) => s.error);
  const chats = useChat((s) => s.chats);
  const activeId = useChat((s) => s.activeId);
  const chat = useChat((s) => s.chat);
  const messages = useChat((s) => s.messages);
  const proposals = useChat((s) => s.proposals);
  const events = useChat((s) => s.events);
  const draftMode = useChat((s) => s.draftMode);
  const pendingRoots = useChat((s) => s.pendingRoots);
  const notice = useChat((s) => s.notice);
  const busy = useChat((s) => s.busy);
  const chosen = useChat(chosenEffort);

  useEffect(() => {
    void useChat.getState().open(projectId, chatId ?? null, useApp.getState().settings.defaultMode);
  }, [projectId, chatId]);
  useEffect(() => () => useChat.getState().reset(), []);

  useChatLive(chat?.sessionId ?? null);

  const mode: MindMode = chat?.mode ?? draftMode;
  // Sin elección en este chat, el esfuerzo de la mente de Ajustes.
  const effort: Effort = chosen ?? settings.mind.effort;
  const running = chat?.state === 'running';
  const roots = chat?.extraRoots ?? pendingRoots;
  const projectName = projectId ? (project?.name ?? projectId) : null;
  const folder = chat?.cwd ?? project?.repoPath ?? null;

  const turns = useMemo(() => splitTurns(events, messages), [events, messages]);
  const draft = useMemo(() => buildReply(turns.pending), [turns.pending]);
  const anchors = useMemo(() => anchorProposals(proposals, messages), [proposals, messages]);
  const pendingInChat = proposals.filter((p) => p.approval === 'proposed').length;
  // Sin turno en curso y con la respuesta ya guardada, lo que quede suelto no se muestra como borrador.
  const showDraft = running || (draft.items.length > 0 && messages.at(-1)?.role !== 'assistant');

  const mindId = chat?.mindAgentId ?? settings.mind.agentId ?? agents.find((a) => a.config.kind === 'claude-sdk' && a.config.enabled)?.config.id ?? null;
  const mindAgent = agents.find((a) => a.config.id === mindId);
  const mind = mindId ? { name: mindAgent?.config.displayName ?? mindId, model: settings.mind.model ?? mindAgent?.config.model } : null;
  const agentName = useCallback((id: string) => agents.find((a) => a.config.id === id)?.config.displayName ?? id, [agents]);

  const toChat = useCallback(
    (id: string, replace = false) =>
      navigate(projectId ? { name: 'project', projectId, chatId: id } : { name: 'standalone', chatId: id }, { replace }),
    [projectId],
  );
  const toRoot = useCallback(() => navigate(projectId ? { name: 'project', projectId } : { name: 'standalone' }, { replace: true }), [projectId]);

  const setMode = useCallback((m: MindMode) => void useChat.getState().setMode(m), []);
  const setEffort = useCallback((e: Effort) => useChat.getState().setEffort(e), []);
  const cycleMode = useCallback(() => {
    const s = useChat.getState();
    void s.setMode(nextMindMode(s.chat?.mode ?? s.draftMode));
  }, []);

  // Shift+Tab fuera de un campo de texto también cambia el modo (en el Composer lo hace el propio Composer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : document.activeElement;
      if (isTextField(target)) return;
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]')) return;
      e.preventDefault();
      cycleMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleMode]);

  /** Crea el chat (el agente suelto necesita una carpeta de trabajo). */
  const createChat = useCallback(async (): Promise<Chat | null> => {
    const store = useChat.getState();
    if (projectId !== null) return store.createChat();
    let cwd: string | null;
    try {
      cwd = await pickFolder();
    } catch (err) {
      store.setNotice(`No se pudo abrir el selector de carpetas: ${errorText(err)}`);
      return null;
    }
    if (!cwd) {
      store.setNotice('Elige una carpeta de trabajo para el agente suelto.');
      return null;
    }
    return store.createChat({ cwd });
  }, [projectId]);

  const onSubmit = useCallback(
    async (turn: { text: string; attachments: Attachment[] }): Promise<boolean> => {
      let current = useChat.getState().chat;
      if (!current) {
        current = await createChat();
        if (!current) return false;
        toChat(current.id, true);
      }
      // Un chat recién creado ya heredó el esfuerzo del borrador.
      const store = useChat.getState();
      return store.send(current.id, turn.text, turn.attachments, effortIn(store.efforts, current.id) ?? useApp.getState().settings.mind.effort);
    },
    [createChat, toChat],
  );

  const onAttach = useCallback(async (file: File): Promise<Attachment> => {
    try {
      return await attachFile(file);
    } catch (err) {
      useChat.getState().setNotice(`No se pudo adjuntar ${file.name}: ${errorText(err)}`);
      throw err;
    }
  }, []);

  const onNew = useCallback(async () => {
    const created = await createChat();
    if (created) toChat(created.id);
  }, [createChat, toChat]);

  const onDelete = useCallback(
    async (id: string) => {
      await useChat.getState().deleteChat(id);
      if (chatId === id) toRoot();
    },
    [chatId, toRoot],
  );

  const onAddRoot = useCallback(async () => {
    const store = useChat.getState();
    try {
      const path = await pickFolder();
      if (!path) return;
      const current = store.chat?.extraRoots ?? store.pendingRoots;
      if (!current.includes(path)) await store.setExtraRoots([...current, path]);
    } catch (err) {
      store.setNotice(`No se pudo abrir el selector de carpetas: ${errorText(err)}`);
    }
  }, []);

  const onRemoveRoot = useCallback((path: string) => {
    const store = useChat.getState();
    const current = store.chat?.extraRoots ?? store.pendingRoots;
    void store.setExtraRoots(current.filter((r) => r !== path));
  }, []);

  const retry = useCallback(() => {
    useChat.getState().reset();
    void useChat.getState().open(projectId, chatId ?? null, useApp.getState().settings.defaultMode);
  }, [projectId, chatId]);

  /** Sale de un chat que ya no existe hacia la conversación más reciente (o una vacía). */
  const goLatest = useCallback(() => {
    toRoot();
    useChat.getState().reset();
    void useChat.getState().open(projectId, null, useApp.getState().settings.defaultMode);
  }, [projectId, toRoot]);

  const scroll = useStickToBottom(`${activeId ?? ''}:${messages.length}:${events.at(-1)?.seq ?? -1}:${running}:${proposals.length}`);

  const proposalsCard = (list: typeof proposals) => (
    <ProposalsCard
      proposals={list}
      pendingInChat={pendingInChat}
      busy={busy}
      agentName={agentName}
      onDecide={(taskId, decision) => void useChat.getState().decide(taskId, decision)}
      onApproveAll={() => void useChat.getState().approveAll()}
    />
  );
  const endProposals = anchors.get(PROPOSALS_AT_END);

  const unavailable = status === 'unavailable';
  const canWrite = status === 'ready' || status === 'missing';
  const empty = status === 'ready' && messages.length === 0 && !showDraft && !endProposals;

  let body: ReactNode;
  if (unavailable) {
    body = (
      <EmptyState
        icon={Unplug}
        title="El chat con la mente aún no está disponible"
        description={`El núcleo de ${APP_NAME} todavía no ofrece /chats. Actualiza el núcleo y vuelve a intentarlo.`}
        action={
          <Button size="sm" variant="secondary" onPress={retry}>
            Reintentar
          </Button>
        }
      />
    );
  } else if (status === 'error') {
    body = (
      <EmptyState
        icon={CircleAlert}
        title="No se pudo abrir la conversación"
        description={error ?? `Revisa que el núcleo de ${APP_NAME} esté corriendo.`}
        action={
          <Button size="sm" variant="secondary" onPress={retry}>
            Reintentar
          </Button>
        }
      />
    );
  } else if (status === 'missing') {
    body = (
      <EmptyState
        icon={MessageSquareOff}
        title="Esta conversación ya no existe"
        description="Se borró o el enlace es antiguo. Escribe abajo para empezar una nueva."
        action={
          <Button size="sm" variant="secondary" onPress={goLatest}>
            Ir a la última conversación
          </Button>
        }
      />
    );
  } else if (status === 'loading' || status === 'idle') {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size="md" color="current" className="text-muted" aria-label="Cargando la conversación" />
      </div>
    );
  } else if (empty) {
    body = <EmptyChat projectName={projectName} onPick={(text) => void onSubmit({ text, attachments: [] })} />;
  } else {
    body = (
      <MessageList
        messages={messages}
        eventsByMessage={turns.byMessage}
        after={(id) => {
          const list = anchors.get(id);
          return list ? proposalsCard(list) : null;
        }}
        tail={
          <>
            {showDraft ? <LiveReply draft={draft} running={running} /> : null}
            {endProposals ? proposalsCard(endProposals) : null}
          </>
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        projectName={projectName}
        folder={folder}
        chats={chats}
        activeId={activeId}
        costUsd={chat ? chat.costUsd : null}
        extraRoots={roots}
        mode={mode}
        isDisabled={unavailable}
        onSelect={(id) => toChat(id)}
        onNew={() => void onNew()}
        onRename={(id, title) => void useChat.getState().renameChat(id, title)}
        onDelete={(id) => void onDelete(id)}
        onAddRoot={() => void onAddRoot()}
        onRemoveRoot={onRemoveRoot}
        onClose={() => navigate({ name: 'home' })}
      />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scroll.ref} onScroll={scroll.onScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[48rem] flex-1 flex-col px-4 py-6">{body}</div>
        </div>
        {scroll.away && !empty ? (
          <button
            type="button"
            aria-label="Ir al último mensaje"
            onClick={scroll.toLatest}
            className="glass-surface absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-foreground/10 bg-[var(--background)] text-muted transition-colors duration-quick hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            <ArrowDown className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <footer className="mx-auto flex w-full max-w-[48rem] shrink-0 flex-col gap-2 px-4 pb-4">
        {notice ? (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[0.8125rem] text-danger">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="selectable min-w-0 flex-1 break-words">{notice}</span>
            <button
              type="button"
              aria-label="Cerrar aviso"
              onClick={() => useChat.getState().setNotice(null)}
              className="flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <TargetLine
          chatId={chat?.id ?? null}
          standalone={projectId === null}
          draft={!chat && canWrite && project ? { path: project.repoPath, worktrees: project.workspace !== undefined } : null}
        />
        {chat && (chat.backgroundTasks ?? 0) > 0 ? <BackgroundLine count={chat.backgroundTasks ?? 0} /> : null}
        <ModeChip mode={mode} onChange={setMode} mind={mind} isDisabled={unavailable} />
        <Composer
          placeholder={projectName ? `Pídele algo a ${APP_NAME} sobre ${projectName}…` : `Pídele algo a ${APP_NAME}…`}
          mode={mode}
          onModeChange={setMode}
          effort={effort}
          onEffortChange={setEffort}
          effortLevels={effortSchema.options}
          onAttach={onAttach}
          onSubmit={onSubmit}
          isStreaming={running}
          onStop={() => void useChat.getState().interrupt()}
          isDisabled={!canWrite}
          showModeChip={false}
        />
      </footer>
    </div>
  );
}
