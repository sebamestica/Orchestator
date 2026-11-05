/**
 * Lo que ocupan los chats dentro de la base del núcleo y su borrado (eventos y sesiones). Solo lectura sobre el resto
 * de las tablas. Las del chat (`chat_*`) las crea su módulo (`CREATE TABLE IF NOT EXISTS`); `chat_targets` puede no
 * existir todavía.
 *
 * - Bytes: páginas reales por tabla e índice (`dbstat`). En las tablas compartidas (`events`, `sessions`) la parte de
 *   los chats se reparte en proporción a los bytes de sus filas. Sin `dbstat`, la suma de los largos.
 * - Sesiones de un chat: la suya (`chat_chats.session_id`) y las de sus subagentes (`parent_session_id`). Los restos
 *   son las `chat-…` cuyo chat ya no existe.
 * - El historial de uso se conserva siempre: las filas de `usage` y los eventos a los que apuntan.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { redactSecrets } from '../../shared/index.ts';
import { ChatDb } from '../chat/db.ts';

const num = z.union([z.number(), z.bigint(), z.null()]).transform((v) => (v === null ? 0 : Number(v)));
const countRow = z.object({ n: num });

const CHAT_SESSIONS = 'SELECT session_id FROM chat_chats';
const CHAT_IDS = 'SELECT id FROM chat_chats';
const NOT_USAGE = 'id NOT IN (SELECT event_id FROM usage)';
const ofChat = (col: string) => `${col} IN (${CHAT_SESSIONS})`;
const ofGoneChat = (col: string) => `(${col} LIKE 'chat-%' AND ${col} NOT IN (${CHAT_SESSIONS}) AND substr(${col}, 6) NOT IN (${CHAT_IDS}))`;

/** Condiciones SQL de cada parte medida, por tabla. */
export const CHAT_ROWS = {
  eventsOfChats: `(${ofChat('session_id')} OR ${ofChat('parent_session_id')}) AND ${NOT_USAGE}`,
  eventsOfGone: `(${ofGoneChat('session_id')} OR ${ofGoneChat('parent_session_id')}) AND ${NOT_USAGE}`,
  sessionsOfChats: `${ofChat('id')} OR ${ofChat('parent_session_id')}`,
  sessionsOfGone: `${ofGoneChat('id')} OR ${ofGoneChat('parent_session_id')}`,
  ofLiveChat: `chat_id IN (${CHAT_IDS})`,
  ofGoneChatId: `chat_id NOT IN (${CHAT_IDS})`,
} as const;

/** Tablas del chat cuyas filas son todas de un chat (vivo o borrado) por `chat_id`. */
const CHAT_ID_TABLES = ['chat_messages', 'chat_proposals', 'chat_targets'] as const;

export interface DbFigures {
  pageSize: number;
  pageCount: number;
  freePages: number;
  chats: { chats: number; running: number; messages: number; events: number; sessions: number; bytes: number; oldestUpdatedAt: string | null };
  leftovers: { rows: number; bytes: number };
}

export interface ChatRow {
  id: string;
  sessionId: string;
  state: string;
  updatedAt: string;
}

const chatRowSchema = z.object({ id: z.string(), session_id: z.string(), state: z.string(), updated_at: z.string() });

export class StorageDb {
  readonly db: DatabaseSync;
  readonly #chat: ChatDb;
  #octet: boolean | undefined;

  constructor(db: DatabaseSync) {
    this.db = db;
    // Crea las tablas del chat si el módulo del chat no corrió (p. ej. la app de la documentación).
    this.#chat = new ChatDb(db);
  }

  #one(sql: string, ...params: SQLInputValue[]): number {
    return countRow.parse(this.#chat.stmt(sql).get(...params) ?? { n: 0 }).n;
  }

  hasTable(name: string): boolean {
    return this.#chat.stmt(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
  }

  /** `octet_length` (SQLite ≥ 3.43) mide sin leer el texto entero; si no está, `LENGTH(CAST(… AS BLOB))`. */
  #lengthOf(col: string): string {
    if (this.#octet === undefined) {
      try {
        this.db.prepare(`SELECT octet_length('a') AS n`).get();
        this.#octet = true;
      } catch {
        this.#octet = false;
      }
    }
    return this.#octet ? `COALESCE(octet_length("${col}"), 0)` : `COALESCE(LENGTH(CAST("${col}" AS BLOB)), 0)`;
  }

  /** Expresión del largo aproximado de una fila (suma de sus columnas + cabecera). */
  #rowLength(table: string): string {
    const cols = z.array(z.object({ name: z.string() }).loose()).parse(this.db.prepare(`PRAGMA table_info("${table}")`).all());
    return [...cols.map((c) => this.#lengthOf(c.name)), '8'].join(' + ');
  }

  /** Bytes de cada tabla con sus índices (`dbstat`), o `undefined` si la base no lo trae. */
  tableBytes(): Map<string, number> | undefined {
    try {
      const rows = this.db
        .prepare('SELECT m.tbl_name AS t, SUM(s.pgsize) AS n FROM dbstat s JOIN sqlite_master m ON m.name = s.name GROUP BY m.tbl_name')
        .all();
      return new Map(rows.map((r) => z.object({ t: z.string(), n: num }).parse(r)).map((r) => [r.t, r.n]));
    } catch {
      return undefined;
    }
  }

  /** Filas y bytes de cada parte de una tabla (`parts`: nombre → condición SQL), en un solo recorrido. */
  #measure(table: string, parts: Readonly<Record<string, string>>, sizes: Map<string, number> | undefined): Record<string, { rows: number; bytes: number }> {
    const names = Object.keys(parts);
    const out: Record<string, { rows: number; bytes: number }> = {};
    if (!this.hasTable(table)) {
      for (const n of names) out[n] = { rows: 0, bytes: 0 };
      return out;
    }
    const len = this.#rowLength(table);
    const cols = names.flatMap((n, i) => [`SUM(CASE WHEN ${parts[n]} THEN ${len} ELSE 0 END) AS l${i}`, `SUM(CASE WHEN ${parts[n]} THEN 1 ELSE 0 END) AS c${i}`]);
    const raw = this.db.prepare(`SELECT SUM(${len}) AS total, ${cols.join(', ')} FROM "${table}"`).get() as Record<string, unknown> | undefined;
    const value = (k: string) => num.parse(raw?.[k] ?? null);
    const total = value('total');
    const pages = sizes?.get(table);
    names.forEach((n, i) => {
      const l = value(`l${i}`);
      out[n] = { rows: value(`c${i}`), bytes: pages === undefined ? l : total > 0 ? Math.round((pages * l) / total) : 0 };
    });
    return out;
  }

  #pragma(name: string): number {
    return num.parse((this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined)?.[name] ?? null);
  }

  /** Tamaño de página, páginas y páginas libres (sin recorrer las tablas). */
  pages(): { pageSize: number; pageCount: number; freePages: number } {
    return { pageSize: this.#pragma('page_size'), pageCount: this.#pragma('page_count'), freePages: this.#pragma('freelist_count') };
  }

  figures(): DbFigures {
    const sizes = this.tableBytes();
    const chatTable = (table: string) => this.#measure(table, { all: '1' }, sizes).all ?? { rows: 0, bytes: 0 };
    const events = this.#measure('events', { live: CHAT_ROWS.eventsOfChats, gone: CHAT_ROWS.eventsOfGone }, sizes);
    const sessions = this.#measure('sessions', { live: CHAT_ROWS.sessionsOfChats, gone: CHAT_ROWS.sessionsOfGone }, sizes);
    const byChat = CHAT_ID_TABLES.map((t) => this.#measure(t, { live: CHAT_ROWS.ofLiveChat, gone: CHAT_ROWS.ofGoneChatId }, sizes));
    const chats = chatTable('chat_chats');
    const zero = { rows: 0, bytes: 0 };
    const live = [events.live, sessions.live, ...byChat.map((m) => m.live)].map((p) => p ?? zero);
    const gone = [events.gone, sessions.gone, ...byChat.map((m) => m.gone)].map((p) => p ?? zero);
    const oldest = z.object({ v: z.string().nullable() }).parse(this.db.prepare('SELECT MIN(updated_at) AS v FROM chat_chats').get() ?? { v: null }).v;
    return {
      ...this.pages(),
      chats: {
        chats: chats.rows,
        running: this.#one(`SELECT COUNT(*) AS n FROM chat_chats WHERE state = 'running'`),
        messages: byChat[0]?.live?.rows ?? 0,
        events: events.live?.rows ?? 0,
        sessions: sessions.live?.rows ?? 0,
        bytes: chats.bytes + live.reduce((s, p) => s + p.bytes, 0),
        oldestUpdatedAt: oldest,
      },
      leftovers: { rows: gone.reduce((s, p) => s + p.rows, 0), bytes: gone.reduce((s, p) => s + p.bytes, 0) },
    };
  }

  // ---------------------------------------------------------------- lectura

  chatRows(): ChatRow[] {
    return this.#chat
      .stmt('SELECT id, session_id, state, updated_at FROM chat_chats ORDER BY updated_at, rowid')
      .all()
      .map((r) => chatRowSchema.parse(r))
      .map((r) => ({ id: r.id, sessionId: r.session_id, state: r.state, updatedAt: r.updated_at }));
  }

  chatRow(chatId: string): ChatRow | undefined {
    const raw = this.#chat.stmt('SELECT id, session_id, state, updated_at FROM chat_chats WHERE id = ?').get(chatId);
    if (!raw) return undefined;
    const r = chatRowSchema.parse(raw);
    return { id: r.id, sessionId: r.session_id, state: r.state, updatedAt: r.updated_at };
  }

  countMessages(chatId: string): number {
    return this.#one('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?', chatId);
  }

  /** Por adjunto, los chats (existentes) cuyos mensajes lo usan. */
  attachmentUse(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const rows = this.#chat.stmt(`SELECT chat_id, attachments_json FROM chat_messages WHERE ${CHAT_ROWS.ofLiveChat} AND attachments_json <> '[]'`).all();
    for (const raw of rows) {
      const r = z.object({ chat_id: z.string(), attachments_json: z.string() }).parse(raw);
      let list: unknown;
      try {
        list = JSON.parse(r.attachments_json);
      } catch {
        continue;
      }
      const parsed = z.array(z.object({ id: z.string() }).loose()).safeParse(list);
      if (!parsed.success) continue;
      for (const a of parsed.data) {
        let set = out.get(a.id);
        if (!set) out.set(a.id, (set = new Set()));
        set.add(r.chat_id);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- borrado

  /** Eventos y sesiones de un chat ya borrado y de sus subagentes (sin el historial de uso). */
  deleteSessionRows(sessionId: string): { events: number; sessions: number } {
    return this.#chat.tx(() => ({
      events: Number(this.#chat.stmt(`DELETE FROM events WHERE (session_id = ? OR parent_session_id = ?) AND ${NOT_USAGE}`).run(sessionId, sessionId).changes),
      sessions: Number(this.#chat.stmt('DELETE FROM sessions WHERE id = ? OR parent_session_id = ?').run(sessionId, sessionId).changes),
    }));
  }

  /** Restos de chats ya borrados: mensajes, propuestas, destinos, eventos y sesiones sin chat. */
  deleteLeftovers(): { messages: number; events: number; sessions: number; rows: number } {
    return this.#chat.tx(() => {
      const run = (sql: string) => Number(this.db.prepare(sql).run().changes);
      const messages = run(`DELETE FROM chat_messages WHERE ${CHAT_ROWS.ofGoneChatId}`);
      let rows = messages + run(`DELETE FROM chat_proposals WHERE ${CHAT_ROWS.ofGoneChatId}`);
      if (this.hasTable('chat_targets')) rows += run(`DELETE FROM chat_targets WHERE ${CHAT_ROWS.ofGoneChatId}`);
      const events = run(`DELETE FROM events WHERE ${CHAT_ROWS.eventsOfGone}`);
      const sessions = run(`DELETE FROM sessions WHERE ${CHAT_ROWS.sessionsOfGone}`);
      return { messages, events, sessions, rows: rows + events + sessions };
    });
  }

  /**
   * Compacta: vuelca el WAL, reescribe la base sin páginas libres (`VACUUM`) y vuelve a vaciar el WAL. Falla sin
   * romper nada si hay una transacción abierta o la base está ocupada.
   */
  compact(): { ok: true } | { ok: false; reason: string } {
    if (this.db.isTransaction) return { ok: false, reason: 'hay una transacción abierta; vuelve a intentarlo en un momento' };
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }
}
