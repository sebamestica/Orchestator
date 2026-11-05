import { Button, Popover } from '@heroui/react';
import { Check, ChevronDown, FolderOpen, FolderPlus, FolderX, MessageSquarePlus, MessagesSquare, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Chat, MindMode } from '../../../../shared/api.ts';
import { IconButton } from '../../../components/IconButton.tsx';
import { baseName, chatTitle, formatCost, relativeTime } from '../format.ts';

interface ChatHeaderProps {
  /** `null`: conversación sin proyecto («Conversaciones»). */
  projectName: string | null;
  folder: string | null;
  chats: readonly Chat[];
  activeId: string | null;
  costUsd: number | null;
  extraRoots: readonly string[];
  mode: MindMode;
  /** Sin `/chats` en el núcleo: los controles de conversación quedan apagados. */
  isDisabled?: boolean;
  onSelect: (chatId: string) => void;
  onNew: () => void;
  onRename: (chatId: string, title: string) => void;
  onDelete: (chatId: string) => void;
  onAddRoot: () => void;
  onRemoveRoot: (path: string) => void;
  onClose: () => void;
}

function ChatRow({ chat, active, onSelect, onRename, onDelete }: { chat: Chat; active: boolean; onSelect: () => void; onRename: (title: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  // Al salir de renombrar o de confirmar, el foco vuelve a la fila: si se quedara en un elemento que ya
  // no existe, el popover lo tomaría como foco perdido y se cerraría.
  const rowRef = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (editing || confirming) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      rowRef.current?.focus();
    }
  }, [editing, confirming]);
  const save = () => {
    const t = title.trim();
    if (t && t !== chat.title) onRename(t);
    setEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setTitle(chat.title);
      setEditing(false);
    }
  };
  if (editing) {
    return (
      <li className="flex h-10 items-center gap-1 px-1">
        <input
          autoFocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKey}
          aria-label="Nuevo título de la conversación"
          className="h-8 min-w-0 flex-1 rounded-lg border border-foreground/10 bg-[var(--field-background)] px-2 text-[0.8125rem] text-foreground outline-none focus:border-foreground/30"
        />
        <IconButton label="Guardar título" size="sm" onClick={save}>
          <Check className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton label="Cancelar" size="sm" onClick={() => setEditing(false)}>
          <X className="size-3.5" aria-hidden="true" />
        </IconButton>
      </li>
    );
  }
  if (confirming) {
    return (
      <li className="flex h-10 items-center gap-2 px-2 text-[0.8125rem]">
        <span className="min-w-0 flex-1 truncate">¿Borrar «{chatTitle(chat.title)}»?</span>
        <Button size="sm" variant="danger" onPress={onDelete}>
          Borrar
        </Button>
        <Button size="sm" variant="ghost" onPress={() => setConfirming(false)}>
          Cancelar
        </Button>
      </li>
    );
  }
  return (
    <li className="group relative flex items-center">
      <button
        ref={rowRef}
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={`flex h-10 min-w-0 flex-1 flex-col justify-center rounded-lg px-2 pr-16 text-left transition-colors duration-quick hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${active ? 'bg-foreground/[0.06]' : ''}`}
      >
        <span className="truncate text-[0.8125rem] font-medium text-foreground">{chatTitle(chat.title)}</span>
        <span className="truncate text-[0.6875rem] text-muted">
          {relativeTime(chat.updatedAt)} · {formatCost(chat.costUsd)}
          {chat.state === 'running' ? ' · trabajando' : ''}
        </span>
      </button>
      <div className="reveal absolute right-1 flex items-center gap-0.5">
        <IconButton label={`Renombrar ${chatTitle(chat.title)}`} size="sm" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton label={`Borrar ${chatTitle(chat.title)}`} size="sm" onClick={() => setConfirming(true)}>
          <Trash2 className="size-3.5" aria-hidden="true" />
        </IconButton>
      </div>
    </li>
  );
}

function ConversationPicker({ chats, activeId, isDisabled, onSelect, onNew, onRename, onDelete }: Pick<ChatHeaderProps, 'chats' | 'activeId' | 'isDisabled' | 'onSelect' | 'onNew' | 'onRename' | 'onDelete'>) {
  const [open, setOpen] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  const active = chats.find((c) => c.id === activeId);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="sm"
        isDisabled={isDisabled}
        aria-label="Conversaciones del proyecto"
        className="h-8 min-w-0 max-w-64 gap-2 rounded-full border border-foreground/[0.08] px-3 text-[0.8125rem] font-medium text-foreground"
      >
        <MessagesSquare className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 truncate">{active ? chatTitle(active.title) : 'Nueva conversación'}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      </Button>
      <Popover.Content placement="bottom start" className="w-80">
        <Popover.Dialog aria-label="Conversaciones" className="flex flex-col gap-1 p-1.5">
          {chats.length ? (
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {chats.map((c) => (
                <ChatRow
                  key={c.id}
                  chat={c}
                  active={c.id === activeId}
                  onSelect={() => {
                    setOpen(false);
                    onSelect(c.id);
                  }}
                  onRename={(t) => onRename(c.id, t)}
                  onDelete={() => {
                    // El foco sale de la fila antes de que desaparezca (si no, el popover se cierra).
                    newRef.current?.focus();
                    onDelete(c.id);
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="px-2 py-3 text-center text-[0.8125rem] text-muted">Aún no hay conversaciones.</p>
          )}
          <button
            ref={newRef}
            type="button"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
            className="flex h-9 items-center gap-2 rounded-lg border-t border-foreground/[0.06] px-2 text-[0.8125rem] text-foreground transition-colors duration-quick hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            <MessageSquarePlus className="size-4 text-muted" aria-hidden="true" />
            Nueva conversación
          </button>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

function ExtraRoots({ roots, mode, isDisabled, onAdd, onRemove }: { roots: readonly string[]; mode: MindMode; isDisabled?: boolean; onAdd: () => void; onRemove: (path: string) => void }) {
  return (
    <Popover>
      <Button variant="ghost" size="sm" isDisabled={isDisabled} aria-label="Carpetas extra" className="h-8 gap-1.5 px-2.5 text-[0.8125rem]">
        <FolderPlus className="size-4 text-muted" aria-hidden="true" />
        <span className="hidden lg:inline">Carpetas extra</span>
        {roots.length ? <span className="tabular-nums text-muted">{roots.length}</span> : null}
      </Button>
      <Popover.Content placement="bottom end" className="w-96">
        <Popover.Dialog aria-label="Carpetas extra" className="flex flex-col gap-2 p-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-[0.875rem] font-medium text-foreground">Carpetas extra</p>
            <p className="text-[0.75rem] text-muted">
              La mente también puede leer estas carpetas. {mode === 'bypass' ? 'En Bypass puede leer cualquier carpeta.' : 'En Bypass, cualquier carpeta.'}
            </p>
          </div>
          {roots.length ? (
            <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
              {roots.map((r) => (
                <li key={r} className="flex h-9 items-center gap-2 rounded-lg px-2 hover:bg-foreground/[0.045]">
                  <FolderOpen className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-[0.75rem]" title={r}>
                    {r}
                  </span>
                  <IconButton label={`Quitar carpeta ${baseName(r)}`} size="sm" onClick={() => onRemove(r)}>
                    <X className="size-3.5" aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg bg-foreground/[0.03] px-3 py-2 text-[0.8125rem] text-muted">Sin carpetas extra.</p>
          )}
          <Button size="sm" variant="secondary" onPress={onAdd} className="self-start">
            <FolderPlus className="size-3.5" aria-hidden="true" />
            Agregar carpeta
          </Button>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

/** Encabezado del chat: proyecto y carpeta, conversaciones, costo, carpetas extra y «Cerrar carpeta». */
export function ChatHeader(props: ChatHeaderProps) {
  const { projectName, folder, costUsd, extraRoots, mode, isDisabled, onAddRoot, onRemoveRoot, onClose } = props;
  return (
    <header className="flex h-[var(--app-header-height)] shrink-0 items-center gap-3 px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2.5">
        {projectName !== null ? (
          <FolderOpen className="size-4 shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <MessagesSquare className="size-4 shrink-0 text-muted" aria-hidden="true" />
        )}
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[0.875rem] font-medium text-foreground">{projectName ?? 'Conversaciones'}</span>
          {folder ? (
            <span className="selectable truncate text-[0.6875rem] text-muted" title={folder}>
              {folder}
            </span>
          ) : null}
        </div>
      </div>
      <ConversationPicker {...props} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {costUsd !== null ? (
          <span className="px-2 text-[0.75rem] tabular-nums text-muted" title="Costo de esta conversación" aria-label={`Costo de esta conversación: ${formatCost(costUsd)}`}>
            {formatCost(costUsd)}
          </span>
        ) : null}
        <ExtraRoots roots={extraRoots} mode={mode} isDisabled={isDisabled} onAdd={onAddRoot} onRemove={onRemoveRoot} />
        {/* Una conversación no tiene carpeta abierta que cerrar. */}
        {projectName !== null ? (
          <Button variant="ghost" size="sm" onPress={onClose} aria-label="Cerrar carpeta" className="h-8 gap-1.5 px-2.5 text-[0.8125rem]">
            <FolderX className="size-4 text-muted" aria-hidden="true" />
            <span className="hidden md:inline">Cerrar carpeta</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
