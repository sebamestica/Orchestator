/**
 * Línea «¿dónde quedan los cambios?» encima del input del chat (issue 2): sus textos y la carga del destino del chat
 * (`GET /chats/:id/target`, validado con Zod). Se recarga al cambiar de chat, al reconectar `/ws` y con cada
 * `chat_target`, sin recargar la vista.
 */
import { useEffect, useState } from 'react';
import { chatTargetMessageSchema, chatTargetResponse, type ChangesTarget } from '../../../shared/api.ts';
import { api } from '../../api/client.ts';
import { getLive } from '../../api/live.ts';

/** Partes de la línea: la ruta o la URL va aparte para truncarla (con `title` completo). */
export interface TargetLineParts {
  kind: 'local' | 'remote';
  /** Texto antes de la ruta o la URL. */
  lead: string;
  /** Carpeta donde se guarda o repositorio adonde se subiría. */
  place: string;
  /** Texto después. */
  tail: string;
}

export const NOT_CONFIGURED_NOTE = ' (el remoto no está configurado en la carpeta)';

/** Repositorio para mostrar: la URL (ya saneada por el núcleo) sin `https://` ni `.git`, o el nombre del remoto. */
export function displayRemote(remote: { name: string | null; url: string }): string {
  const url = remote.url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return url || remote.name || 'un repositorio';
}

/**
 * Textos de la línea:
 * - local sin git: «Local · se guarda en C:\dev\marketing · sin git»;
 * - local con git: «Local · se guarda en C:\dev\marketing · no se sube a ningún repositorio»;
 * - proyecto con worktrees: «Local · C:\dev\orquestador · ramas orq/… · no se sube»;
 * - remoto: «Se subirá a github.com/a/b · rama main · solo con tu aprobación» (+ aviso si no está configurado);
 * - chat sin proyecto: «Local · <carpeta del chat>».
 */
export function targetLineParts(target: ChangesTarget, opts: { standalone?: boolean } = {}): TargetLineParts {
  if (target.kind === 'remote') {
    const branch = target.branch ? ` · rama ${target.branch}` : '';
    return { kind: 'remote', lead: 'Se subirá a ', place: displayRemote(target.remote), tail: `${branch} · solo con tu aprobación${target.configured ? '' : NOT_CONFIGURED_NOTE}` };
  }
  if (opts.standalone) return { kind: 'local', lead: 'Local · ', place: target.path, tail: '' };
  if (target.worktrees) return { kind: 'local', lead: 'Local · ', place: target.path, tail: ' · ramas orq/… · no se sube' };
  return { kind: 'local', lead: 'Local · se guarda en ', place: target.path, tail: target.git === 'none' ? ' · sin git' : ' · no se sube a ningún repositorio' };
}

/** Conversación nueva (aún sin chat): arranca en local, en la carpeta del proyecto. Sin carpeta, nada. */
export function draftLineParts(draft: { path: string; worktrees: boolean } | null): TargetLineParts | null {
  if (!draft?.path) return null;
  if (draft.worktrees) return { kind: 'local', lead: 'Local · ', place: draft.path, tail: ' · ramas orq/… · no se sube' };
  return { kind: 'local', lead: 'Local · se guarda en ', place: draft.path, tail: '' };
}

export const targetLineText = (parts: TargetLineParts): string => `${parts.lead}${parts.place}${parts.tail}`;

export type TargetStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface TargetState {
  status: TargetStatus;
  target: ChangesTarget | null;
}

/** Destino del chat: lo pide al montar y al cambiar de chat o reconectar, y lo actualiza con `chat_target`. */
export function useChangesTarget(chatId: string | null): TargetState {
  const [state, setState] = useState<TargetState & { chatId: string | null }>({ chatId: null, status: 'idle', target: null });

  useEffect(() => {
    if (!chatId) {
      setState({ chatId: null, status: 'idle', target: null });
      return;
    }
    let alive = true;
    /** Cada respuesta o mensaje nuevo invalida las cargas que siguen en vuelo. */
    let version = 0;
    const load = async () => {
      const mine = ++version;
      let next: TargetState;
      try {
        const parsed = chatTargetResponse.safeParse(await api.get<unknown>(`/chats/${encodeURIComponent(chatId)}/target`));
        next = parsed.success ? { status: 'ready', target: parsed.data.target } : { status: 'error', target: null };
      } catch {
        next = { status: 'error', target: null };
      }
      if (alive && mine === version) setState({ chatId, ...next });
    };
    setState({ chatId, status: 'loading', target: null });
    void load();

    const live = getLive();
    const offMessages = live?.subscribe((message) => {
      if (message.type !== 'chat_target' || message.chatId !== chatId) return;
      const parsed = chatTargetMessageSchema.safeParse(message);
      if (!parsed.success) return;
      version++;
      setState({ chatId, status: 'ready', target: parsed.data.target });
    });
    const offStatus = live?.onStatus((status) => {
      if (status === 'open') void load();
    });
    return () => {
      alive = false;
      offMessages?.();
      offStatus?.();
    };
  }, [chatId]);

  // Hasta que corre el efecto del chat nuevo no se muestra el destino del anterior.
  if (state.chatId !== chatId) return { status: chatId ? 'loading' : 'idle', target: null };
  return { status: state.status, target: state.target };
}
