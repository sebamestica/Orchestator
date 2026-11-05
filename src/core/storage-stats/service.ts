/**
 * Almacenamiento de Berland (issue 13): cuánto ocupan en disco los adjuntos subidos, los chats, las carpetas de las
 * conversaciones y la base, y su vaciado. Los proyectos y sus worktrees no cuentan y nunca se tocan.
 *
 * - Adjuntos: copias de `<dataDir>/attachments` (los registrados por ruta son del usuario: ni se cuentan ni se
 *   borran). «Sin usar»: ningún mensaje de un chat vivo los usa, o son archivos sueltos sin registro.
 * - Chats: se borran con el puerto (`DELETE /chats/:id`); después, sus eventos y sesiones (sin el historial de uso) y
 *   su carpeta de conversación. Los que están respondiendo o con subagentes vivos no se tocan.
 * - Carpetas de conversaciones: las hijas de `conversationsRoot` cuyo chat ya no existe.
 * - Base: checkpoint del WAL + `VACUUM`, para que lo borrado se libere de verdad.
 *
 * Lo reciente (menos de `graceMs`, 1 h) y sin usar no se vacía: puede ser un adjunto en el compositor o la carpeta de
 * un chat que se está creando. Todo borrado pasa por `safetyProblem`.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { STORAGE_GRACE_MS, opaqueIdSchema, redactSecrets } from '../../shared/index.ts';
import type { StorageCleanChatsBody, StorageCleanResult, StorageSummary, StorageTarget } from '../../shared/index.ts';
import { AttachmentStore } from '../chat/attachments.ts';
import { conversationDir, conversationsRoot } from '../chat/conversations.ts';
import type { ProjectRecord } from '../store/index.ts';
import { defaultWorktreesRoot } from '../workspace/config.ts';
import type { LiveChat, StorageChatsPort } from './chats-port.ts';
import { StorageDb, type ChatRow } from './db.ts';
import { DEFAULT_WALK_ENTRIES, listDir, lstatOrUndefined, pathKey, removeTree, safetyProblem, treeSize, type DirEntryInfo, type SafetyRules, type WalkBudget } from './fs.ts';

export type StorageErrorCode = 'conflict' | 'not_configured';
export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StorageServiceOptions {
  /** `store.database` del núcleo. */
  db: DatabaseSync;
  /** Proyectos registrados: su carpeta y su raíz de worktrees nunca se tocan. */
  projects: () => readonly ProjectRecord[];
  dataDir: string;
  /** `orquestador.db` (o `:memory:` en pruebas). */
  dbPath: string;
  /** Por defecto `<dataDir>/attachments`. */
  attachmentsDir?: string;
  /** Por defecto `conversationsRoot(dataDir)`. */
  conversationsRoot?: string;
  /** Más caminos que nunca se tocan (bóveda, memoria de Obsidian…), además de los proyectos y la base. */
  protectedPaths?: () => readonly string[];
  graceMs?: number;
  /** Tope de entradas al recorrer las carpetas de conversaciones. */
  maxWalkEntries?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const MAX_SKIPPED = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const attachmentRowSchema = z.object({ id: z.string(), kind: z.string(), source: z.string(), path: z.string(), created_at: z.string() });

interface AttachmentRow {
  id: string;
  kind: string;
  source: string;
  path: string;
  createdAt: string;
}

interface AttachmentScan {
  rows: AttachmentRow[];
  /** Archivos regulares de la carpeta, por `pathKey`. */
  files: Map<string, DirEntryInfo>;
  /** Por adjunto, los chats vivos que lo usan. */
  use: Map<string, Set<string>>;
}

interface FolderInfo {
  name: string;
  path: string;
  bytes: number;
  files: number;
  orphan: boolean;
  recent: boolean;
}

class Result {
  readonly value: StorageCleanResult;
  constructor(target: StorageTarget) {
    this.value = {
      target,
      deleted: { chats: 0, messages: 0, events: 0, sessions: 0, attachments: 0, files: 0, folders: 0 },
      freedBytes: 0,
      skipped: [],
      compacted: false,
      warnings: [],
    };
  }
  skip(id: string, reason: string): void {
    if (this.value.skipped.length < MAX_SKIPPED) this.value.skipped.push({ id, reason });
  }
  warn(text: string): void {
    if (this.value.warnings.length < 20) this.value.warnings.push(redactSecrets(text).slice(0, 300));
  }
  get anyDeleted(): boolean {
    const d = this.value.deleted;
    return d.chats + d.messages + d.events + d.sessions + d.attachments + d.files + d.folders > 0;
  }
}

function errText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
}

export class StorageService {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly conversationsRoot: string;
  readonly #sdb: StorageDb;
  readonly #attachments: AttachmentStore;
  readonly #opts: StorageServiceOptions;
  readonly #grace: number;
  readonly #now: () => Date;
  #busy = false;

  constructor(opts: StorageServiceOptions) {
    this.#opts = opts;
    this.dataDir = path.resolve(opts.dataDir);
    this.dbPath = opts.dbPath === ':memory:' ? opts.dbPath : path.resolve(opts.dbPath);
    this.attachmentsDir = path.resolve(opts.attachmentsDir ?? path.join(this.dataDir, 'attachments'));
    this.conversationsRoot = path.resolve(opts.conversationsRoot ?? conversationsRoot(this.dataDir));
    this.#sdb = new StorageDb(opts.db);
    this.#attachments = new AttachmentStore({ db: opts.db, dir: this.attachmentsDir });
    this.#grace = opts.graceMs ?? STORAGE_GRACE_MS;
    this.#now = opts.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- medición

  async summary(live: readonly LiveChat[] | null = null): Promise<StorageSummary> {
    const now = this.#now();
    const figures = this.#sdb.figures();
    const chatRows = this.#sdb.chatRows();
    const scan = await this.#scanAttachments();
    const budget: WalkBudget = { left: this.#opts.maxWalkEntries ?? DEFAULT_WALK_ENTRIES, truncated: false };
    const folders = await this.#scanConversations(chatRows, budget, now);
    const rootStats = await lstatOrUndefined(this.conversationsRoot);

    const amount = () => ({ count: 0, bytes: 0 });
    const total = amount();
    const images = amount();
    const orphans = amount();
    const matched = new Set<string>();
    let linkedFiles = 0;
    for (const row of scan.rows) {
      if (row.source !== 'upload') {
        linkedFiles++;
        continue;
      }
      const file = scan.files.get(pathKey(row.path));
      if (!file) continue;
      matched.add(pathKey(row.path));
      if (row.kind === 'image') add(images, file.stats.size);
      if (!scan.use.has(row.id) && this.#old(row.createdAt, now)) add(orphans, file.stats.size);
    }
    for (const [key, file] of scan.files) {
      add(total, file.stats.size);
      if (!matched.has(key) && this.#oldMs(file.stats.mtimeMs, now)) add(orphans, file.stats.size);
    }

    const db = await this.#dbFiles(figures.pageCount * figures.pageSize);
    const liveById = new Map((live ?? []).map((c) => [c.id, c]));
    const busy = chatRows.filter((c) => busyReason(c, liveById.get(c.id)) !== undefined).length;
    const used = (figures.pageCount - figures.freePages) * figures.pageSize;
    const chatBytes = figures.chats.bytes + figures.leftovers.bytes;
    const convTotal = { count: folders.length, bytes: folders.reduce((s, f) => s + f.bytes, 0) };
    const convOrphans = folders.filter((f) => f.orphan && !f.recent);

    return {
      measuredAt: now.toISOString(),
      totalBytes: total.bytes + convTotal.bytes + db.total,
      attachments: {
        dir: this.attachmentsDir,
        total,
        images,
        others: { count: total.count - images.count, bytes: total.bytes - images.bytes },
        orphans,
        linkedFiles,
      },
      chats: {
        chats: figures.chats.chats,
        busy,
        messages: figures.chats.messages,
        events: figures.chats.events,
        sessions: figures.chats.sessions,
        bytes: figures.chats.bytes,
        leftovers: { count: figures.leftovers.rows, bytes: figures.leftovers.bytes },
        oldestUpdatedAt: isoOrNull(figures.chats.oldestUpdatedAt),
      },
      conversations: {
        root: this.conversationsRoot,
        exists: rootStats?.isDirectory() === true || rootStats?.isSymbolicLink() === true,
        total: convTotal,
        orphans: { count: convOrphans.length, bytes: convOrphans.reduce((s, f) => s + f.bytes, 0) },
        truncated: budget.truncated,
      },
      database: {
        path: this.dbPath,
        fileBytes: db.file,
        walBytes: db.wal,
        shmBytes: db.shm,
        totalBytes: db.total,
        freeBytes: figures.freePages * figures.pageSize,
        chatBytes,
        otherBytes: Math.max(0, used - chatBytes),
      },
    };
  }

  // ---------------------------------------------------------------- vaciado

  /** `orphans`: copias que ningún mensaje usa y archivos sueltos; `all`: todas las copias subidas. */
  cleanAttachments(scope: 'orphans' | 'all', live: readonly LiveChat[] | null): Promise<StorageCleanResult> {
    return this.#exclusive(async () => {
      const now = this.#now();
      const out = new Result('attachments');
      const rules = this.#rules();
      const scan = await this.#scanAttachments();
      const busy = this.#busyChats(live);
      const known = new Set<string>();
      for (const row of scan.rows) {
        known.add(pathKey(row.path));
        if (row.source !== 'upload') continue;
        const users = scan.use.get(row.id);
        // «Sin usar» nunca toca lo que un chat usa: no es un omitido.
        if (scope === 'orphans' && users) continue;
        if (users && [...users].some((id) => busy.has(id))) {
          out.skip(row.id, 'lo usa un chat que está respondiendo o con subagentes trabajando');
          continue;
        }
        if (!users && !this.#old(row.createdAt, now)) {
          out.skip(row.id, 'se subió hace menos de 1 h y aún no se envía');
          continue;
        }
        const file = scan.files.get(pathKey(row.path));
        if (file) {
          const why = await safetyProblem(file.path, this.attachmentsDir, rules);
          if (why) {
            out.skip(row.id, why);
            continue;
          }
        }
        try {
          await this.#attachments.remove(row.id);
        } catch (err) {
          out.skip(row.id, `no se pudo borrar: ${errText(err)}`);
          continue;
        }
        out.value.deleted.attachments++;
        if (file && !(await lstatOrUndefined(file.path))) {
          out.value.deleted.files++;
          out.value.freedBytes += file.stats.size;
        }
      }
      // Archivos sueltos: en la carpeta de adjuntos y sin registro (p. ej. de una subida a medias).
      for (const [key, file] of scan.files) {
        if (known.has(key)) continue;
        if (!this.#oldMs(file.stats.mtimeMs, now)) {
          out.skip(file.name, 'archivo suelto de hace menos de 1 h');
          continue;
        }
        await this.#remove(out, file.path, this.attachmentsDir, rules, file.name, 'files');
      }
      return out.value;
    });
  }

  /** Chats todos o de más de N días (sin los que están en curso), o los restos de chats ya borrados. */
  cleanChats(body: StorageCleanChatsBody, port: StorageChatsPort): Promise<StorageCleanResult> {
    return this.#exclusive(async () => {
      const out = new Result('chats');
      const dbBefore = await this.#dbTotal();
      const attBefore = await this.#attachmentBytes();
      let folderBytes = 0;
      if (body.scope === 'leftovers') {
        const n = this.#sdb.deleteLeftovers();
        out.value.deleted.messages += n.messages;
        out.value.deleted.events += n.events;
        out.value.deleted.sessions += n.sessions;
      } else {
        const live = await port.list();
        if (live === null) throw new StorageError('not_configured', 'El chat no está disponible en este arranque: no se pueden borrar chats');
        const liveById = new Map(live.map((c) => [c.id, c]));
        const cutoff = body.scope === 'older' ? this.#now().getTime() - (body.olderThanDays ?? 0) * DAY_MS : undefined;
        const rules = this.#rules();
        for (const chat of this.#sdb.chatRows()) {
          if (cutoff !== undefined && !(Date.parse(chat.updatedAt) < cutoff)) continue;
          // El estado se vuelve a leer justo antes: el chat pudo empezar a responder mientras se borraban otros.
          const fresh = this.#sdb.chatRow(chat.id);
          if (!fresh) continue;
          const why = busyReason(fresh, liveById.get(chat.id));
          if (why) {
            out.skip(chat.id, why);
            continue;
          }
          const messages = this.#sdb.countMessages(chat.id);
          let outcome: 'deleted' | 'missing';
          try {
            outcome = await port.delete(chat.id);
          } catch (err) {
            out.skip(chat.id, errText(err));
            continue;
          }
          if (outcome === 'deleted') {
            out.value.deleted.chats++;
            out.value.deleted.messages += messages;
          }
          const rows = this.#sdb.deleteSessionRows(chat.sessionId);
          out.value.deleted.events += rows.events;
          out.value.deleted.sessions += rows.sessions;
          const folder = conversationDir(this.conversationsRoot, chat.id);
          const stats = await lstatOrUndefined(folder);
          if (stats?.isDirectory() && !stats.isSymbolicLink()) folderBytes += await this.#remove(out, folder, this.conversationsRoot, rules, chat.id, 'folders');
        }
      }
      await this.#compactAfter(out, body.compact !== false);
      out.value.freedBytes = Math.max(0, dbBefore - (await this.#dbTotal())) + Math.max(0, attBefore - (await this.#attachmentBytes())) + folderBytes;
      return out.value;
    });
  }

  /** Carpetas de conversaciones cuyo chat ya no existe (las de un chat vivo se borran con el chat). */
  cleanConversations(): Promise<StorageCleanResult> {
    return this.#exclusive(async () => {
      const now = this.#now();
      const out = new Result('conversations');
      const rules = this.#rules();
      const budget: WalkBudget = { left: 0, truncated: false };
      for (const f of await this.#scanConversations(this.#sdb.chatRows(), budget, now, false)) {
        if (!f.orphan) continue;
        if (f.recent) {
          out.skip(f.name, 'se creó o cambió hace menos de 1 h');
          continue;
        }
        out.value.freedBytes += await this.#remove(out, f.path, this.conversationsRoot, rules, f.name, 'folders');
      }
      return out.value;
    });
  }

  /** Checkpoint del WAL + `VACUUM`: lo borrado deja de ocupar el archivo. */
  compact(): Promise<StorageCleanResult> {
    return this.#exclusive(async () => {
      const out = new Result('database');
      const before = await this.#dbTotal();
      await this.#compactAfter(out, true);
      out.value.freedBytes = Math.max(0, before - (await this.#dbTotal()));
      return out.value;
    });
  }

  // ---------------------------------------------------------------- interno

  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new StorageError('conflict', 'Ya se está vaciando el almacenamiento: espera a que termine');
    this.#busy = true;
    try {
      return await fn();
    } finally {
      this.#busy = false;
    }
  }

  #rules(): SafetyRules {
    const projects = this.#opts.projects().flatMap((p) => [p.repoPath, ...(p.workspace ? [p.workspace.worktreesRoot ?? defaultWorktreesRoot(p.id)] : [])]);
    const db = this.dbPath === ':memory:' ? [] : [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`];
    return { protectedPaths: [...projects, ...db, ...(this.#opts.protectedPaths?.() ?? [])].filter(Boolean), keepRoots: [this.dataDir] };
  }

  /** Borra con la guardia; devuelve los bytes liberados (0 si no se pudo, con el motivo en `skipped`). */
  async #remove(out: Result, target: string, root: string, rules: SafetyRules, id: string, kind: 'files' | 'folders'): Promise<number> {
    const why = await safetyProblem(target, root, rules);
    if (why) {
      out.skip(id, why);
      this.#opts.log?.(redactSecrets(`almacenamiento: no se borra ${target}: ${why}`));
      return 0;
    }
    try {
      const r = await removeTree(target);
      if (kind === 'folders') out.value.deleted.folders++;
      out.value.deleted.files += r.files;
      if (kind === 'files') out.value.freedBytes += r.bytes;
      return r.bytes;
    } catch (err) {
      out.skip(id, `no se pudo borrar del todo: ${errText(err)}`);
      return 0;
    }
  }

  async #compactAfter(out: Result, wanted: boolean): Promise<void> {
    if (!wanted || (out.value.target !== 'database' && !out.anyDeleted)) return;
    const r = this.#sdb.compact();
    out.value.compacted = r.ok;
    if (!r.ok) out.warn(`No se pudo compactar la base: ${r.reason}`);
  }

  #busyChats(live: readonly LiveChat[] | null): Set<string> {
    const liveById = new Map((live ?? []).map((c) => [c.id, c]));
    return new Set(this.#sdb.chatRows().filter((c) => busyReason(c, liveById.get(c.id)) !== undefined).map((c) => c.id));
  }

  #old(iso: string, now: Date): boolean {
    const t = Date.parse(iso);
    return Number.isNaN(t) || now.getTime() - t >= this.#grace;
  }

  #oldMs(ms: number, now: Date): boolean {
    return now.getTime() - ms >= this.#grace;
  }

  async #scanAttachments(): Promise<AttachmentScan> {
    const rows = this.#opts.db
      .prepare('SELECT id, kind, source, path, created_at FROM chat_attachments')
      .all()
      .map((r) => attachmentRowSchema.parse(r))
      .map((r) => ({ id: r.id, kind: r.kind, source: r.source, path: r.path, createdAt: r.created_at }));
    const files = new Map<string, DirEntryInfo>();
    for (const e of await listDir(this.attachmentsDir)) if (e.stats.isFile()) files.set(pathKey(e.path), e);
    return { rows, files, use: this.#sdb.attachmentUse() };
  }

  async #attachmentBytes(): Promise<number> {
    let n = 0;
    for (const e of await listDir(this.attachmentsDir)) if (e.stats.isFile()) n += e.stats.size;
    return n;
  }

  /** Hijas directas de la raíz de conversaciones (carpetas reales con nombre de id; nunca enlaces). */
  async #scanConversations(chats: readonly ChatRow[], budget: WalkBudget, now: Date, measure = true): Promise<FolderInfo[]> {
    const ids = new Set(chats.map((c) => c.id.toLowerCase()));
    const out: FolderInfo[] = [];
    for (const e of await listDir(this.conversationsRoot)) {
      if (!e.stats.isDirectory() || e.stats.isSymbolicLink() || !opaqueIdSchema.safeParse(e.name).success) continue;
      const size = measure ? await treeSize(e.path, budget) : { bytes: 0, files: 0 };
      out.push({ name: e.name, path: e.path, ...size, orphan: !ids.has(e.name.toLowerCase()), recent: !this.#oldMs(e.stats.mtimeMs, now) });
    }
    return out;
  }

  async #dbFiles(inMemory: number): Promise<{ file: number; wal: number; shm: number; total: number }> {
    if (this.dbPath === ':memory:') return { file: inMemory, wal: 0, shm: 0, total: inMemory };
    const size = async (p: string) => {
      try {
        return (await stat(p)).size;
      } catch {
        return 0;
      }
    };
    const [file, wal, shm] = await Promise.all([size(this.dbPath), size(`${this.dbPath}-wal`), size(`${this.dbPath}-shm`)]);
    return { file, wal, shm, total: file + wal + shm };
  }

  async #dbTotal(): Promise<number> {
    const f = this.#sdb.pages();
    return (await this.#dbFiles(f.pageCount * f.pageSize)).total;
  }
}

/** Por qué no se puede borrar un chat ahora (`undefined`: se puede). */
export function busyReason(chat: Pick<ChatRow, 'state'>, live: LiveChat | undefined): string | undefined {
  if (chat.state === 'running' || live?.state === 'running') return 'está respondiendo';
  const n = live?.backgroundTasks ?? 0;
  if (n > 0) return `tiene ${n} subagente${n === 1 ? '' : 's'} trabajando`;
  return undefined;
}

function add(a: { count: number; bytes: number }, bytes: number): void {
  a.count++;
  a.bytes += bytes;
}

function isoOrNull(v: string | null): string | null {
  return v !== null && z.iso.datetime({ offset: true }).safeParse(v).success ? v : null;
}
