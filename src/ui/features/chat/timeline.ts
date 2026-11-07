/**
 * Funciones puras de la vista de chat: arman la respuesta en vivo desde los `AgentEvent` de la sesión de
 * la mente, parten los eventos por turnos (con el `at` de los mensajes guardados) y anclan las propuestas
 * al mensaje de la mente que las trajo. Sin React ni red: se prueban solas.
 */
import { COMPACTED_DETAIL, type AgentEvent, type ChatMessage, type Proposal, type Usage } from '../../../shared/index.ts';

/** Historia en memoria por sesión (docs/plan/F5-INTERFAZ.md §2 «Recursos»). */
export const MAX_SESSION_EVENTS = 500;

export interface ToolResult {
  ok: boolean;
  summary: string;
}

export type LiveItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; callId: string; name: string; input: string; result: ToolResult | null }
  | { kind: 'file'; key: string; path: string; change: 'add' | 'modify' | 'delete' }
  | { kind: 'error'; key: string; message: string }
  /** El SDK compactó la conversación: desde aquí la mente trabaja con un resumen de lo anterior. */
  | { kind: 'compact'; key: string };

/** Paso de trabajo (todo lo que no es texto de la respuesta). */
export type StepItem = Exclude<LiveItem, { kind: 'text' }>;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** `null` si ningún evento trajo costo. */
  costUsd: number | null;
  models: string[];
}

export interface ReplyDraft {
  items: LiveItem[];
  usage: UsageTotals | null;
  /** Llegó `done` (la mente terminó el turno aunque la respuesta aún no esté guardada). */
  done: boolean;
}

/**
 * Une eventos nuevos a la historia: sin duplicados por `seq` (el `replay` y el vivo se cruzan), en orden
 * y recortada a los últimos `max`. Devuelve el mismo arreglo si no hay nada nuevo.
 */
export function mergeEvents(prev: readonly AgentEvent[], incoming: readonly AgentEvent[], max = MAX_SESSION_EVENTS): AgentEvent[] {
  if (incoming.length === 0) return prev as AgentEvent[];
  const last = prev.at(-1)?.seq ?? -1;
  let next: AgentEvent[];
  let inOrder = true;
  let prevSeq = last;
  for (const e of incoming) {
    if (e.seq <= prevSeq) {
      inOrder = false;
      break;
    }
    prevSeq = e.seq;
  }
  if (inOrder) {
    next = prev.concat(incoming);
  } else {
    const bySeq = new Map<number, AgentEvent>();
    for (const e of prev) bySeq.set(e.seq, e);
    let added = false;
    for (const e of incoming) {
      if (!bySeq.has(e.seq)) {
        bySeq.set(e.seq, e);
        added = true;
      }
    }
    if (!added) return prev as AgentEvent[];
    next = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Arma la respuesta (texto por deltas, herramientas con su resultado, archivos, errores y uso). */
export function buildReply(events: readonly AgentEvent[]): ReplyDraft {
  const items: LiveItem[] = [];
  const toolIndex = new Map<string, number>();
  const usageByModel = new Map<string, Usage>();
  let done = false;
  for (const e of events) {
    switch (e.type) {
      case 'text': {
        const kind = e.payload.role === 'assistant' ? 'text' : 'thinking';
        const tail = items.at(-1);
        if (tail && tail.kind === kind) items[items.length - 1] = { ...tail, text: tail.text + e.payload.text };
        else items.push({ kind, key: `${kind}-${e.seq}`, text: e.payload.text });
        break;
      }
      case 'tool_call':
        toolIndex.set(e.payload.callId, items.length);
        items.push({ kind: 'tool', key: `tool-${e.payload.callId}-${e.seq}`, callId: e.payload.callId, name: e.payload.name, input: e.payload.inputSummary, result: null });
        break;
      case 'tool_result': {
        const at = toolIndex.get(e.payload.callId);
        const tool = at === undefined ? undefined : items[at];
        const result = { ok: e.payload.ok, summary: e.payload.summary };
        if (at !== undefined && tool?.kind === 'tool') items[at] = { ...tool, result };
        else items.push({ kind: 'tool', key: `tool-${e.payload.callId}-${e.seq}`, callId: e.payload.callId, name: 'Herramienta', input: '', result });
        break;
      }
      case 'file_change':
        items.push({ kind: 'file', key: `file-${e.seq}`, path: e.payload.path, change: e.payload.change });
        break;
      case 'error':
        items.push({ kind: 'error', key: `error-${e.seq}`, message: e.payload.message });
        break;
      case 'usage':
        // El SDK manda el uso acumulado por modelo: vale el último de cada uno.
        usageByModel.set(e.payload.model ?? '', e.payload);
        break;
      case 'done':
        done = true;
        break;
      case 'status':
        if (e.payload.detail === COMPACTED_DETAIL) items.push({ kind: 'compact', key: `compact-${e.seq}` });
        break;
      default:
        break;
    }
  }
  return { items, usage: totalUsage(usageByModel), done };
}

function totalUsage(byModel: ReadonlyMap<string, Usage>): UsageTotals | null {
  if (byModel.size === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  const models: string[] = [];
  for (const [model, u] of byModel) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    if (u.costUsd !== undefined) costUsd = (costUsd ?? 0) + u.costUsd;
    if (model) models.push(model);
  }
  return { inputTokens, outputTokens, costUsd, models };
}

/** Pasos de trabajo (herramientas, archivos, errores y compactaciones) de un turno ya respondido. */
export function activityOf(draft: ReplyDraft): StepItem[] {
  return draft.items.filter((i): i is StepItem => i.kind === 'tool' || i.kind === 'file' || i.kind === 'error' || i.kind === 'compact');
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export interface Turns {
  /** Eventos de cada mensaje de la mente guardado: los que llegaron entre el mensaje anterior y él. */
  byMessage: Map<string, AgentEvent[]>;
  /**
   * Turnos que terminaron sin respuesta guardada (fallaron, se cortaron o se detuvieron antes de escribir), por
   * el id del mensaje tras el que van: sus eventos quedaron antes del siguiente mensaje del usuario.
   */
  orphans: Map<string, AgentEvent[]>;
  /** Eventos posteriores al último mensaje: la respuesta en curso. */
  pending: AgentEvent[];
}

const STEP_EVENTS: ReadonlySet<AgentEvent['type']> = new Set(['tool_call', 'tool_result', 'file_change', 'error']);

/**
 * Parte la historia de la sesión por turnos. Cada mensaje de la mente se queda con los eventos con
 * `ts` en (mensaje anterior, mensaje]; lo que llegó después del último mensaje es el borrador en vivo.
 * Así, al llegar el `chat_message` final, el borrador se vacía solo. Si lo que precede a un mensaje del
 * usuario trae pasos y se cerró (`done`, error, cancelado), es un turno sin respuesta y se ancla al mensaje anterior
 * (los eventos sueltos, como un `usage` tardío, se descartan). Si no se cerró, el mensaje entró al turno en curso y
 * esos pasos siguen con la respuesta de ese turno.
 */
export function splitTurns(events: readonly AgentEvent[], messages: readonly ChatMessage[]): Turns {
  const byMessage = new Map<string, AgentEvent[]>();
  const orphans = new Map<string, AgentEvent[]>();
  if (messages.length === 0) return { byMessage, orphans, pending: [...events] };
  const bounds = messages.map((m) => time(m.at));
  let i = 0;
  let mi = 0;
  const list = [...events];
  // Pasos de un turno que siguió vivo tras un mensaje del usuario («Ahora», a mitad de turno): van a la respuesta que
  // cierra ese turno (o al borrador), no a un «turno sin respuesta» (mente-10).
  let carry: AgentEvent[] = [];
  while (mi < messages.length) {
    const m = messages[mi];
    const until = bounds[mi] ?? 0;
    const chunk: AgentEvent[] = carry;
    carry = [];
    while (i < list.length && time(list[i]?.ts ?? '') <= until) {
      const e = list[i];
      if (e) chunk.push(e);
      i++;
    }
    const prev = messages[mi - 1];
    if (m && m.role === 'assistant' && chunk.length) byMessage.set(m.id, chunk);
    else if (prev && chunk.some((e) => STEP_EVENTS.has(e.type))) {
      if (chunk.some(closesTurn)) orphans.set(prev.id, chunk);
      else carry = chunk;
    }
    mi++;
  }
  return { byMessage, orphans, pending: [...carry, ...list.slice(i)] };
}

/** Evento que cierra un turno de la mente: su `done`, un error o el estado cancelado o fallido (Detener, caída). */
function closesTurn(e: AgentEvent): boolean {
  if (e.type === 'done' || e.type === 'error') return true;
  return e.type === 'status' && (e.payload.state === 'cancelled' || e.payload.state === 'failed' || e.payload.state === 'done');
}

/**
 * Ancla cada propuesta al primer mensaje de la mente guardado en o después de `proposedAt`
 * (la mente propone y luego cierra su respuesta). Sin ese mensaje, va al final (turno en curso).
 */
export const PROPOSALS_AT_END = '__end__';
export function anchorProposals(proposals: readonly Proposal[], messages: readonly ChatMessage[]): Map<string, Proposal[]> {
  const anchors = new Map<string, Proposal[]>();
  const assistant = messages.filter((m) => m.role === 'assistant');
  for (const p of proposals) {
    const at = time(p.proposedAt);
    const anchor = assistant.find((m) => time(m.at) >= at)?.id ?? PROPOSALS_AT_END;
    const list = anchors.get(anchor);
    if (list) list.push(p);
    else anchors.set(anchor, [p]);
  }
  return anchors;
}

/** Mensajes en orden cronológico y sin duplicados por id (el vivo y el REST se cruzan). */
export function upsertMessage(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === message.id);
  if (i >= 0) {
    const next = [...list];
    next[i] = message;
    return next;
  }
  const next = [...list, message];
  const last = list.at(-1);
  if (last && time(last.at) > time(message.at)) next.sort((a, b) => time(a.at) - time(b.at));
  return next;
}
