/**
 * Estado de la vista de chat con la mente (una sola vista a la vez): conversaciones del proyecto, chat
 * activo, mensajes, propuestas e historia de eventos de su sesión. Las acciones hablan con `/chats` (c15).
 * El estado global de la app (proyectos, agentes, ajustes) sigue en `src/ui/store/app.ts`.
 */
import { z } from 'zod';
import { create } from 'zustand';
import type { AgentEvent, Attachment, Chat, ChatMessage, MindMode, Proposal } from '../../../shared/index.ts';
import { effortSchema, opaqueIdSchema, type Effort, type SendMessageBody } from '../../../shared/api.ts';
import { api, ApiError } from '../../api/client.ts';
import type { LiveMessage } from '../../api/live.ts';
import { mergeEvents, upsertMessage } from './timeline.ts';

export type ChatStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'missing' | 'error';
export type Decision = 'approve' | 'reject';

const enc = encodeURIComponent;

/** El núcleo aún no tiene `/chats` (c15): ruta desconocida, método no admitido o respuesta que no es JSON. */
export function isUnavailable(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  if (!(err instanceof ApiError)) return false;
  if (err.status === 405 || err.status === 501) return true;
  return err.status === 404 && /ruta no encontrada/i.test(err.message);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const byRecent = (a: Chat, b: Chat) => b.updatedAt.localeCompare(a.updatedAt);

function upsertChat(list: readonly Chat[], chat: Chat): Chat[] {
  return [...list.filter((c) => c.id !== chat.id), chat].sort(byRecent);
}

/** La versión más nueva del chat: lo que ya llegó por /ws gana a una foto REST más vieja (con empate, la foto). */
function fresher(current: Chat | null | undefined, incoming: Chat): Chat {
  return current?.id === incoming.id && current.updatedAt > incoming.updatedAt ? current : incoming;
}

/** Foto REST de mensajes más los que llegaron por /ws mientras se pedía (los mensajes solo se agregan). */
function withLiveMessages(snapshot: readonly ChatMessage[], live: readonly ChatMessage[], chatId: string): ChatMessage[] {
  const known = new Set(snapshot.map((m) => m.id));
  let merged = [...snapshot];
  for (const m of live) if (m.chatId === chatId && !known.has(m.id)) merged = upsertMessage(merged, m);
  return merged;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Lee `{proposals}` o `{proposal}` de una respuesta de aprobar o rechazar; `null` si no trae ninguna. */
export function proposalsFrom(res: unknown, current: readonly Proposal[]): Proposal[] | null {
  if (!isRecord(res)) return null;
  if (Array.isArray(res.proposals)) return res.proposals as Proposal[];
  const one = res.proposal;
  if (isRecord(one) && isRecord(one.task) && typeof one.task.id === 'string') {
    const p = one as unknown as Proposal;
    return current.map((c) => (c.task.id === p.task.id ? p : c));
  }
  return null;
}

/** Aprobadas que no llegaron a la flota: `failed` de la respuesta de aprobar (`approvalResponse` del núcleo). */
const failedSchema = z.array(z.object({ taskId: z.string(), reason: z.string() }));
export type DeliveryFailure = z.infer<typeof failedSchema>[number];
/** Motivo por el que cada propuesta `approved` no llegó a la flota (id de tarea → motivo). */
export type Undelivered = Readonly<Record<string, string>>;

/** Lee `failed` de una respuesta de aprobar; si no viene o no tiene la forma esperada, vacío. */
export function failedFrom(res: unknown): DeliveryFailure[] {
  const r = failedSchema.safeParse(isRecord(res) ? res.failed : undefined);
  return r.success ? r.data : [];
}

/** Aviso de las tareas que no se entregaron (una línea por tarea); `null` si se entregaron todas. */
export function deliveryNotice(failed: readonly DeliveryFailure[]): string | null {
  return failed.length ? failed.map((f) => `No se pudo entregar ${f.taskId} a la flota: ${f.reason}`).join('\n') : null;
}

/** Motivos que siguen valiendo tras `proposals` (con los nuevos de `failed`): solo de las que siguen `approved`. */
export function undeliveredAfter(prev: Undelivered, proposals: readonly Proposal[], failed: readonly DeliveryFailure[] = []): Record<string, string> {
  const approved = new Set(proposals.filter((p) => p.approval === 'approved').map((p) => p.task.id));
  const entries = [...Object.entries(prev), ...failed.map((f) => [f.taskId, f.reason] as const)];
  return Object.fromEntries(entries.filter(([id]) => approved.has(id)));
}

/** Motivo conocido de una tarea sin entregar (solo propiedades propias: un id no puede leer `Object.prototype`). */
export function undeliveredReason(undelivered: Undelivered, taskId: string): string | null {
  return Object.hasOwn(undelivered, taskId) ? (undelivered[taskId] ?? null) : null;
}

/**
 * Aún no está en la flota: sin decidir, o aprobada sin entregar (una aprobada entregada pasa enseguida a
 * `delegated`). Es lo que aprueba «Aprobar todo», igual que `ChatService.approveAll`.
 */
export function awaitsDelivery(p: Proposal): boolean {
  return p.approval === 'proposed' || p.approval === 'approved';
}

/** Elige una carpeta: diálogo nativo de Electron o, en la web, el diálogo de Windows del núcleo. */
export async function pickFolder(): Promise<string | null> {
  const bridge = typeof window === 'undefined' ? undefined : window.orq;
  if (bridge) return bridge.pickFolder();
  const r = await api.post<{ path: string | null }>('/fs/pick-folder');
  return r.path;
}

/** Adjunta un archivo: por ruta en Electron (sin copiar bytes) o subiendo los bytes en la web. */
export async function attachFile(file: File): Promise<Attachment> {
  const path = typeof window === 'undefined' ? null : (window.orq?.pathForFile(file) ?? null);
  const r = path
    ? await api.post<{ attachment: Attachment }>('/attachments/by-path', { path })
    : await api.upload<{ attachment: Attachment }>('/attachments', file, file.name);
  return r.attachment;
}

// ── Esfuerzo de razonamiento por chat ────────────────────────────────────────────────────────

/** Clave de `localStorage` con el esfuerzo elegido en cada chat (respaldo del store). */
export const EFFORT_STORAGE_KEY = 'berland.chat.effort';
/** Chats recordados como máximo (se olvidan los más antiguos). */
export const MAX_REMEMBERED_EFFORTS = 200;

type Efforts = Readonly<Record<string, Effort>>;

/** Esfuerzo guardado de un chat (solo propiedades propias: un id no puede leer `Object.prototype`). */
export function effortIn(efforts: Efforts, chatId: string): Effort | null {
  return Object.hasOwn(efforts, chatId) ? (efforts[chatId] ?? null) : null;
}

/** Lee el respaldo; lo que no sea `{ chatId: esfuerzo }` válido se descarta. Sin almacenamiento, vacío. */
export function readEfforts(): Record<string, Effort> {
  try {
    const raw = globalThis.localStorage?.getItem(EFFORT_STORAGE_KEY);
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) return {};
    return Object.fromEntries(
      Object.entries(data).flatMap(([id, value]) => {
        const effort = effortSchema.safeParse(value);
        return opaqueIdSchema.safeParse(id).success && effort.success ? [[id, effort.data] as const] : [];
      }).slice(-MAX_REMEMBERED_EFFORTS),
    );
  } catch {
    return {};
  }
}

function writeEfforts(efforts: Efforts): void {
  try {
    globalThis.localStorage?.setItem(EFFORT_STORAGE_KEY, JSON.stringify(efforts));
  } catch {
    // Sin almacenamiento (modo privado, cuota llena): el esfuerzo queda solo en memoria.
  }
}

/** Pone `chatId` al final (el más reciente) y recorta a los últimos `MAX_REMEMBERED_EFFORTS`. */
function withEffort(efforts: Efforts, chatId: string, effort: Effort | null): Record<string, Effort> {
  const rest = Object.entries(efforts).filter(([id]) => id !== chatId);
  return Object.fromEntries((effort ? [...rest, [chatId, effort] as const] : rest).slice(-MAX_REMEMBERED_EFFORTS));
}

interface ChatData {
  projectId: string | null;
  status: ChatStatus;
  error: string | null;
  chats: Chat[];
  activeId: string | null;
  chat: Chat | null;
  messages: ChatMessage[];
  proposals: Proposal[];
  /** Por qué no llegaron a la flota las propuestas `approved` (de las respuestas de aprobar de esta vista). */
  undelivered: Undelivered;
  /** Eventos de `chat.sessionId` (últimos 500, por `seq`). */
  events: AgentEvent[];
  /** Último `seq` visto de la sesión: desde ahí se pide `replay` al reconectar. */
  lastSeq: number;
  /** Modo mientras aún no hay chat (se usa al crearlo). */
  draftMode: MindMode;
  /** Carpetas extra elegidas antes de crear el chat. */
  pendingRoots: string[];
  /** Aviso breve de una acción fallida. */
  notice: string | null;
  /** Propuestas con una acción en curso (`'*'` = aprobar todo). */
  busy: Record<string, true>;
  /** Esfuerzo elegido en cada chat (id → nivel), con respaldo en `localStorage`. Sobrevive a `open`. */
  efforts: Efforts;
  /** Esfuerzo elegido antes de crear el chat: pasa al chat nuevo al crearlo. */
  draftEffort: Effort | null;
}

/**
 * Esfuerzo elegido para el próximo mensaje: el del chat abierto (o del que se está abriendo) o, sin chat, el del
 * borrador. `null`: no se eligió; la vista usa el de Ajustes.
 */
export function chosenEffort(s: Pick<ChatData, 'chat' | 'activeId' | 'status' | 'efforts' | 'draftEffort'>): Effort | null {
  const id = s.chat?.id ?? (s.status === 'loading' ? s.activeId : null);
  return id ? effortIn(s.efforts, id) : s.draftEffort;
}

interface ChatActions {
  reset(): void;
  open(projectId: string | null, chatId: string | null, defaultMode: MindMode): Promise<void>;
  select(chatId: string): Promise<void>;
  refresh(): Promise<void>;
  createChat(opts?: { cwd?: string }): Promise<Chat | null>;
  renameChat(chatId: string, title: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  setMode(mode: MindMode): Promise<void>;
  setExtraRoots(roots: string[]): Promise<void>;
  /** Recuerda el esfuerzo del chat abierto (o del borrador, si aún no hay chat). */
  setEffort(effort: Effort): void;
  send(chatId: string, text: string, attachments: Attachment[], effort?: Effort): Promise<boolean>;
  interrupt(): Promise<void>;
  decide(taskId: string, decision: Decision): Promise<void>;
  approveAll(): Promise<void>;
  ingest(events: readonly AgentEvent[]): void;
  applyLive(message: LiveMessage): void;
  setNotice(notice: string | null): void;
}

export type ChatStore = ChatData & ChatActions;

/** Estado de una apertura nueva. `efforts` no está: se recuerda entre aperturas. */
const INITIAL: Omit<ChatData, 'efforts'> = {
  projectId: null,
  status: 'idle',
  error: null,
  chats: [],
  activeId: null,
  chat: null,
  messages: [],
  proposals: [],
  undelivered: {},
  events: [],
  lastSeq: -1,
  draftMode: 'plan',
  pendingRoots: [],
  notice: null,
  busy: {},
  draftEffort: null,
};

/** Cambia en cada `open`/`reset`: las respuestas de una apertura anterior se descartan. */
let generation = 0;

export const useChat = create<ChatStore>((set, get) => {
  /** Carga un chat (datos, mensajes y propuestas) si sigue siendo el activo. */
  async function load(chatId: string, gen: number): Promise<void> {
    const alive = () => gen === generation && get().activeId === chatId;
    const base = `/chats/${enc(chatId)}`;
    try {
      const [c, m] = await Promise.all([api.get<{ chat: Chat }>(base), api.get<{ messages: ChatMessage[] }>(`${base}/messages`)]);
      if (!alive()) return;
      const sameSession = get().chat?.sessionId === c.chat.sessionId;
      // Lo que /ws aplicó mientras la carga estaba en vuelo puede ser más nuevo que la foto: se une, no se pisa.
      set((s) => {
        const chat = fresher(s.chat, c.chat);
        const listed = s.chats.find((x) => x.id === chat.id);
        return {
          status: 'ready',
          error: null,
          chat,
          chats: listed ? s.chats.map((x) => (x === listed ? fresher(listed, chat) : x)) : upsertChat(s.chats, chat),
          messages: withLiveMessages(m.messages, s.messages, chatId),
          ...(sameSession ? {} : { events: [], lastSeq: -1 }),
        };
      });
    } catch (err) {
      if (!alive()) return;
      if (isUnavailable(err)) set({ status: 'unavailable', error: null });
      else if (err instanceof ApiError && err.status === 404) set({ status: 'missing', chat: null, messages: [], proposals: [], undelivered: {} });
      else set({ status: 'error', error: errorText(err) });
      return;
    }
    try {
      const p = await api.get<{ proposals: Proposal[] }>(`${base}/proposals`);
      if (alive()) setProposals(p.proposals);
    } catch {
      // Sin propuestas (o la ruta aún no existe): el hilo sigue funcionando.
    }
  }

  async function refetchProposals(chatId: string): Promise<void> {
    try {
      const p = await api.get<{ proposals: Proposal[] }>(`/chats/${enc(chatId)}/proposals`);
      if (get().activeId === chatId) setProposals(p.proposals);
    } catch {
      // Se queda con lo que había; el mensaje `proposals` de /ws lo corrige.
    }
  }

  /** Pone las propuestas y deja los motivos de «sin entregar» al día (con los nuevos de `failed`). */
  function setProposals(proposals: Proposal[], failed: readonly DeliveryFailure[] = []): void {
    set((s) => ({ proposals, undelivered: undeliveredAfter(s.undelivered, proposals, failed) }));
  }

  /** Guarda (o, con `null`, olvida) el esfuerzo de un chat, en el store y en el respaldo. */
  function rememberEffort(chatId: string, effort: Effort | null): void {
    if (effort === null && !Object.hasOwn(get().efforts, chatId)) return;
    const efforts = withEffort(get().efforts, chatId, effort);
    writeEfforts(efforts);
    set({ efforts });
  }

  function setBusy(key: string, on: boolean) {
    set((s) => ({
      busy: on ? { ...s.busy, [key]: true } : (Object.fromEntries(Object.entries(s.busy).filter(([k]) => k !== key)) as Record<string, true>),
    }));
  }

  return {
    ...INITIAL,
    efforts: readEfforts(),

    reset() {
      generation++;
      set({ ...INITIAL, efforts: readEfforts() });
    },

    async open(projectId, chatId, defaultMode) {
      const s = get();
      const sameScope = s.status !== 'idle' && s.projectId === projectId;
      const settled = s.status === 'ready' || s.status === 'loading';
      // Misma carpeta y mismo chat (p. ej. la ruta recibe el id del chat recién creado): nada que hacer.
      if (sameScope && settled && (chatId === s.activeId || (chatId === null && s.activeId !== null))) return;
      if (sameScope && chatId !== null && s.status !== 'unavailable' && s.status !== 'error') {
        await get().select(chatId);
        return;
      }
      const gen = ++generation;
      set({ ...INITIAL, projectId, status: 'loading', draftMode: defaultMode });
      let chats: Chat[];
      try {
        const r = await api.get<{ chats: Chat[] }>(projectId ? `/chats?projectId=${enc(projectId)}` : '/chats');
        chats = r.chats.filter((c) => c.projectId === projectId).sort(byRecent);
      } catch (err) {
        if (gen !== generation) return;
        set(isUnavailable(err) ? { status: 'unavailable' } : { status: 'error', error: errorText(err) });
        return;
      }
      if (gen !== generation) return;
      const id = chatId ?? chats[0]?.id ?? null;
      set({ chats, activeId: id, status: id ? 'loading' : 'ready' });
      if (id) await load(id, gen);
    },

    async select(chatId) {
      if (get().activeId === chatId && get().status === 'ready') return;
      set({ activeId: chatId, status: 'loading', chat: null, messages: [], proposals: [], undelivered: {}, events: [], lastSeq: -1, notice: null, busy: {} });
      await load(chatId, generation);
    },

    async refresh() {
      const id = get().activeId;
      if (id && get().status === 'ready') await load(id, generation);
    },

    async createChat(opts = {}) {
      const { projectId, draftMode, pendingRoots, draftEffort } = get();
      const gen = generation;
      try {
        const r = await api.post<{ chat: Chat }>('/chats', {
          projectId,
          mode: draftMode,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(pendingRoots.length ? { extraRoots: pendingRoots } : {}),
        });
        // Lo elegido en el borrador queda como esfuerzo del chat nuevo.
        if (draftEffort) rememberEffort(r.chat.id, draftEffort);
        if (gen !== generation) return r.chat;
        set((s) => ({
          chats: upsertChat(s.chats, r.chat),
          activeId: r.chat.id,
          chat: r.chat,
          messages: [],
          proposals: [],
          undelivered: {},
          events: [],
          lastSeq: -1,
          pendingRoots: [],
          draftEffort: null,
          status: 'ready',
          notice: null,
        }));
        return r.chat;
      } catch (err) {
        set(isUnavailable(err) ? { status: 'unavailable' } : { notice: `No se pudo crear la conversación: ${errorText(err)}` });
        return null;
      }
    },

    async renameChat(chatId, title) {
      try {
        const r = await api.patch<{ chat: Chat }>(`/chats/${enc(chatId)}`, { title });
        set((s) => ({ chats: upsertChat(s.chats, r.chat), chat: s.chat?.id === chatId ? r.chat : s.chat }));
      } catch (err) {
        set({ notice: `No se pudo renombrar: ${errorText(err)}` });
      }
    },

    async deleteChat(chatId) {
      try {
        await api.del<unknown>(`/chats/${enc(chatId)}`);
      } catch (err) {
        set({ notice: `No se pudo borrar: ${errorText(err)}` });
        return;
      }
      rememberEffort(chatId, null);
      const rest = get().chats.filter((c) => c.id !== chatId);
      set({ chats: rest });
      if (get().activeId !== chatId) return;
      const next = rest[0];
      if (next) {
        await get().select(next.id);
      } else {
        set({ activeId: null, chat: null, messages: [], proposals: [], undelivered: {}, events: [], lastSeq: -1, status: 'ready' });
      }
    },

    async setMode(mode) {
      const chat = get().chat;
      if (!chat) {
        set({ draftMode: mode });
        return;
      }
      const prev = chat.mode;
      if (prev === mode) return;
      set((s) => ({ chat: s.chat?.id === chat.id ? { ...s.chat, mode } : s.chat }));
      try {
        const r = await api.patch<{ chat?: Chat }>(`/chats/${enc(chat.id)}`, { mode });
        if (r?.chat) {
          const updated = r.chat;
          set((s) => ({ chat: s.chat?.id === chat.id ? updated : s.chat, chats: upsertChat(s.chats, updated) }));
        }
      } catch (err) {
        set((s) => ({ chat: s.chat?.id === chat.id ? { ...s.chat, mode: prev } : s.chat, notice: `No se pudo cambiar el modo: ${errorText(err)}` }));
      }
    },

    async setExtraRoots(roots) {
      const chat = get().chat;
      if (!chat) {
        set({ pendingRoots: roots });
        return;
      }
      try {
        const r = await api.patch<{ chat?: Chat }>(`/chats/${enc(chat.id)}`, { extraRoots: roots });
        const updated = r?.chat ?? { ...chat, extraRoots: roots };
        set((s) => ({ chat: s.chat?.id === chat.id ? updated : s.chat, chats: upsertChat(s.chats, updated) }));
      } catch (err) {
        set({ notice: `No se pudieron guardar las carpetas extra: ${errorText(err)}` });
      }
    },

    setEffort(effort) {
      const chat = get().chat;
      if (chat) rememberEffort(chat.id, effort);
      else set({ draftEffort: effort });
    },

    async send(chatId, text, attachments, effort) {
      const body: SendMessageBody = { text, attachmentIds: attachments.map((a) => a.id), ...(effort ? { effort } : {}) };
      try {
        const r = await api.post<{ message?: ChatMessage; chat?: Chat }>(`/chats/${enc(chatId)}/messages`, body);
        if (get().activeId !== chatId) return true;
        set((s) => ({
          messages: r?.message ? upsertMessage(s.messages, r.message) : s.messages,
          chat: r?.chat ?? (s.chat ? { ...s.chat, state: 'running' } : s.chat),
          notice: null,
        }));
        return true;
      } catch (err) {
        set({ notice: `No se pudo enviar: ${errorText(err)}` });
        return false;
      }
    },

    async interrupt() {
      const chat = get().chat;
      if (!chat) return;
      try {
        const r = await api.post<{ chat?: Chat }>(`/chats/${enc(chat.id)}/interrupt`);
        // Sin turno que cortar, el núcleo no difunde nada: su respuesta es lo único que destraba la vista.
        const fresh = r?.chat;
        if (fresh) set((s) => (s.chat?.id === fresh.id && fresh.updatedAt >= s.chat.updatedAt ? { chat: fresh, chats: upsertChat(s.chats, fresh) } : {}));
      } catch (err) {
        set({ notice: `No se pudo detener: ${errorText(err)}` });
      }
    },

    async decide(taskId, decision) {
      const chat = get().chat;
      if (!chat || get().busy[taskId]) return;
      const before = get().proposals;
      const approval = decision === 'approve' ? 'approved' : 'rejected';
      setBusy(taskId, true);
      set({ proposals: before.map((p) => (p.task.id === taskId ? { ...p, approval } : p)) });
      try {
        const r = await api.post<unknown>(`/chats/${enc(chat.id)}/proposals/${enc(taskId)}/${decision}`);
        // Otro chat abierto mientras tanto: la respuesta (lista, motivos, aviso) no es suya.
        if (get().activeId !== chat.id) return;
        const failed = decision === 'approve' ? failedFrom(r) : [];
        const next = proposalsFrom(r, get().proposals);
        if (next) setProposals(next, failed);
        else await refetchProposals(chat.id);
        if (decision === 'approve') set({ notice: deliveryNotice(failed) });
      } catch (err) {
        if (get().activeId !== chat.id) return;
        set({ proposals: before, notice: `No se pudo ${decision === 'approve' ? 'aprobar' : 'rechazar'} ${taskId}: ${errorText(err)}` });
      } finally {
        setBusy(taskId, false);
      }
    },

    async approveAll() {
      const chat = get().chat;
      if (!chat || get().busy['*']) return;
      const before = get().proposals;
      setBusy('*', true);
      set({ proposals: before.map((p) => (p.approval === 'proposed' ? { ...p, approval: 'approved' } : p)) });
      try {
        const r = await api.post<unknown>(`/chats/${enc(chat.id)}/proposals/approve-all`);
        if (get().activeId !== chat.id) return;
        const failed = failedFrom(r);
        const next = proposalsFrom(r, get().proposals);
        if (next) setProposals(next, failed);
        else await refetchProposals(chat.id);
        set({ notice: deliveryNotice(failed) });
      } catch (err) {
        if (get().activeId !== chat.id) return;
        set({ proposals: before, notice: `No se pudo aprobar todo: ${errorText(err)}` });
      } finally {
        setBusy('*', false);
      }
    },

    ingest(events) {
      const sessionId = get().chat?.sessionId;
      if (!sessionId || events.length === 0) return;
      const mine = events.filter((e) => e.sessionId === sessionId);
      if (mine.length === 0) return;
      set((s) => {
        const merged = mergeEvents(s.events, mine);
        if (merged === s.events) return {};
        return { events: merged, lastSeq: Math.max(s.lastSeq, merged.at(-1)?.seq ?? -1) };
      });
    },

    applyLive(message) {
      const s = get();
      switch (message.type) {
        case 'chat': {
          const chat = message.chat;
          if (chat.projectId !== s.projectId) return;
          set((st) => ({ chats: upsertChat(st.chats, chat), chat: st.activeId === chat.id ? chat : st.chat }));
          return;
        }
        case 'chat_message':
          if (message.message.chatId === s.activeId) set((st) => ({ messages: upsertMessage(st.messages, message.message) }));
          return;
        case 'chat_deleted':
          rememberEffort(message.chatId, null);
          set((st) => ({ chats: st.chats.filter((c) => c.id !== message.chatId) }));
          if (message.chatId === s.activeId) set({ status: 'missing', chat: null, messages: [], proposals: [], undelivered: {}, events: [], lastSeq: -1 });
          return;
        case 'proposals':
          if (message.chatId === s.activeId) setProposals(message.proposals);
          return;
        default:
          return;
      }
    },

    setNotice(notice) {
      set({ notice });
    },
  };
});
