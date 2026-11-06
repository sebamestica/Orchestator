/**
 * Tablas del chat con la mente en el SQLite del núcleo (`store.database`). Se crean con `CREATE TABLE IF NOT EXISTS`
 * (el esquema del núcleo, `store/schema.ts`, no se toca). Cada fila se valida con Zod al leerla: el archivo es un dato
 * externo. Los textos llegan ya tachados (`redactSecrets`) desde el servicio.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { attachmentSchema, chatMessageSchema, chatSchema } from '../../shared/index.ts';
import type { Attachment, Chat, ChatMessage } from '../../shared/index.ts';

export const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_chats (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  extra_roots_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  mind_agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sdk_session_id TEXT,
  state TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_chats_project ON chat_chats(project_id, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id);
CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_proposals (
  task_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  approval TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  delegated_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_proposals_chat ON chat_proposals(chat_id);
CREATE INDEX IF NOT EXISTS chat_proposals_project ON chat_proposals(project_id);
`;

export class ChatDbError extends Error {
  override name = 'ChatDbError';
}

/** Sentencias preparadas y transacción sobre la conexión compartida del núcleo. */
export class ChatDb {
  readonly db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(CHAT_SCHEMA);
  }

  stmt(sql: string): StatementSync {
    let s = this.#statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.#statements.set(sql, s);
    }
    return s;
  }

  /** Transacción corta (síncrona). Si ya hay una abierta en la conexión, se suma a ella. */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

const text = z.string();
const optText = z.string().nullable();
const num = z.union([z.number(), z.bigint()]).transform(Number);

const chatRow = z.object({
  id: text,
  project_id: optText,
  title: text,
  cwd: text,
  extra_roots_json: text,
  mode: text,
  mind_agent_id: text,
  session_id: text,
  sdk_session_id: optText,
  state: text,
  cost_usd: num,
  created_at: text,
  updated_at: text,
});
const messageRow = z.object({ id: text, chat_id: text, role: text, text, attachments_json: text, mode: text, at: text });
const attachmentRow = z.object({ id: text, name: text, mime: text, size: num, path: text, kind: text, source: text, created_at: text });

/** Chat guardado con lo que no sale por la API (el `session_id` del SDK para reanudar). */
export interface StoredChat {
  chat: Chat;
  sdkSessionId: string | null;
}

export type ChatUpdate = Partial<Pick<Chat, 'title' | 'mode' | 'extraRoots' | 'state' | 'costUsd' | 'mindAgentId' | 'updatedAt'>> & {
  sdkSessionId?: string | null;
};

const COLUMNS: Record<keyof ChatUpdate, string> = {
  title: 'title',
  mode: 'mode',
  extraRoots: 'extra_roots_json',
  state: 'state',
  costUsd: 'cost_usd',
  mindAgentId: 'mind_agent_id',
  updatedAt: 'updated_at',
  sdkSessionId: 'sdk_session_id',
};

function toChat(raw: unknown): StoredChat {
  const r = chatRow.parse(raw);
  const chat = chatSchema.parse({
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    cwd: r.cwd,
    extraRoots: JSON.parse(r.extra_roots_json) as unknown,
    mode: r.mode,
    mindAgentId: r.mind_agent_id,
    sessionId: r.session_id,
    state: r.state,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  return { chat, sdkSessionId: r.sdk_session_id };
}

function toMessage(raw: unknown): ChatMessage {
  const r = messageRow.parse(raw);
  return chatMessageSchema.parse({
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    text: r.text,
    attachments: JSON.parse(r.attachments_json) as unknown,
    mode: r.mode,
    at: r.at,
  });
}

export function toAttachment(raw: unknown): Attachment {
  const r = attachmentRow.parse(raw);
  return attachmentSchema.parse({ id: r.id, name: r.name, mime: r.mime, size: r.size, path: r.path, kind: r.kind, source: r.source, createdAt: r.created_at });
}

const CHAT_COLUMNS = 'id, project_id, title, cwd, extra_roots_json, mode, mind_agent_id, session_id, sdk_session_id, state, cost_usd, created_at, updated_at';

/** Chats y mensajes. */
export class ChatRepo {
  readonly #db: ChatDb;

  constructor(db: ChatDb) {
    this.#db = db;
  }

  insert(chat: Chat): StoredChat {
    const c = chatSchema.parse(chat);
    this.#db
      .stmt(`INSERT INTO chat_chats (${CHAT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run(c.id, c.projectId, c.title, c.cwd, JSON.stringify(c.extraRoots), c.mode, c.mindAgentId, c.sessionId, c.state, c.costUsd, c.createdAt, c.updatedAt);
    return { chat: c, sdkSessionId: null };
  }

  get(id: string): StoredChat | undefined {
    const raw = this.#db.stmt(`SELECT ${CHAT_COLUMNS} FROM chat_chats WHERE id = ?`).get(id);
    return raw ? toChat(raw) : undefined;
  }

  /** Más recientes primero. `projectId: null` lista las conversaciones sin proyecto; `undefined`, todos. */
  list(projectId?: string | null): Chat[] {
    const order = 'ORDER BY updated_at DESC, rowid DESC';
    const rows =
      projectId === undefined
        ? this.#db.stmt(`SELECT ${CHAT_COLUMNS} FROM chat_chats ${order}`).all()
        : projectId === null
          ? this.#db.stmt(`SELECT ${CHAT_COLUMNS} FROM chat_chats WHERE project_id IS NULL ${order}`).all()
          : this.#db.stmt(`SELECT ${CHAT_COLUMNS} FROM chat_chats WHERE project_id = ? ${order}`).all(projectId);
    return rows.map((r) => toChat(r).chat);
  }

  update(id: string, patch: ChatUpdate): StoredChat {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof ChatUpdate, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${COLUMNS[key]} = ?`);
      params.push(key === 'extraRoots' ? JSON.stringify(value) : (value as SQLInputValue));
    }
    if (sets.length) this.#db.stmt(`UPDATE chat_chats SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    const saved = this.get(id);
    if (!saved) throw new ChatDbError(`No existe el chat ${id}`);
    return saved;
  }

  /** Al arrancar el núcleo no hay turnos vivos: los que quedaron `running` vuelven a `idle`. Devuelve sus ids. */
  resetRunning(at: string): string[] {
    return this.#db.tx(() => {
      const ids = this.#db.stmt(`SELECT id FROM chat_chats WHERE state = 'running'`).all().map((r) => z.object({ id: text }).parse(r).id);
      this.#db.stmt(`UPDATE chat_chats SET state = 'idle', updated_at = ? WHERE state = 'running'`).run(at);
      return ids;
    });
  }

  delete(id: string): boolean {
    return this.#db.tx(() => {
      this.#db.stmt('DELETE FROM chat_messages WHERE chat_id = ?').run(id);
      this.#db.stmt('DELETE FROM chat_proposals WHERE chat_id = ?').run(id);
      return Number(this.#db.stmt('DELETE FROM chat_chats WHERE id = ?').run(id).changes) > 0;
    });
  }

  addMessage(message: ChatMessage): ChatMessage {
    const m = chatMessageSchema.parse(message);
    this.#db
      .stmt('INSERT INTO chat_messages (id, chat_id, role, text, attachments_json, mode, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.chatId, m.role, m.text, JSON.stringify(m.attachments), m.mode, m.at);
    return m;
  }

  /** Los últimos `limit` mensajes, en orden. */
  messages(chatId: string, limit = 500): ChatMessage[] {
    const rows = this.#db
      .stmt('SELECT id, chat_id, role, text, attachments_json, mode, at FROM chat_messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(chatId, Math.max(1, Math.min(limit, 5000)));
    return rows.map(toMessage).reverse();
  }

  countMessages(chatId: string, role?: ChatMessage['role']): number {
    const row = role
      ? this.#db.stmt('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ? AND role = ?').get(chatId, role)
      : this.#db.stmt('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?').get(chatId);
    return z.object({ n: num }).parse(row).n;
  }

  /** Adjuntos de todos los mensajes del chat (para reabrir su lectura al reanudar la sesión). */
  attachmentsOf(chatId: string): Attachment[] {
    const out = new Map<string, Attachment>();
    for (const m of this.messages(chatId, 5000)) for (const a of m.attachments) out.set(a.id, a);
    return [...out.values()];
  }

  /** Ids de adjuntos que aparecen en mensajes de otros chats. */
  attachmentIdsUsedOutside(chatId: string): Set<string> {
    const ids = new Set<string>();
    for (const raw of this.#db.stmt('SELECT attachments_json FROM chat_messages WHERE chat_id <> ?').all(chatId)) {
      const r = z.object({ attachments_json: text }).parse(raw);
      for (const a of z.array(z.object({ id: z.string() }).loose()).parse(JSON.parse(r.attachments_json))) ids.add(a.id);
    }
    return ids;
  }
}
