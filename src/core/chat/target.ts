/**
 * Destino de los cambios de un chat (issue 2): «Local» salvo que el usuario haya indicado en el plan un repositorio
 * donde subirlos (`crear_tareas.destino`). El destino se guarda por chat en `chat_targets` (SQLite del núcleo, con
 * `CREATE TABLE IF NOT EXISTS`) y se resuelve al leerlo contra el git de la carpeta, así `configured` refleja los
 * remotos de ahora. Berland no sube nada: un destino remoto solo queda anotado.
 */
import { z } from 'zod';
import { changesTargetSchema, redactSecrets } from '../../shared/index.ts';
import type { ChangesTarget } from '../../shared/index.ts';
import { readProjectStorage, sameRemoteUrl, sanitizeRemoteUrl, type ProjectStorage } from '../workspace/storage.ts';
import type { ChatDb } from './db.ts';

export const CHAT_TARGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_targets (
  chat_id TEXT PRIMARY KEY,
  remote TEXT NOT NULL,
  branch TEXT,
  updated_at TEXT NOT NULL
);
`;

/** Destino que indicó el usuario, ya saneado: el nombre de un remoto de la carpeta o la URL de un repositorio. */
export interface ChangesDestination {
  remote: string;
  /** Rama indicada en el plan; `null`: la actual de la carpeta. */
  branch: string | null;
}

/** Lo que trae `crear_tareas.destino` (ya validado con Zod por la herramienta). */
export interface DestinationInput {
  remoto: string;
  rama?: string;
}

/** Dónde quedan los cambios: la carpeta del proyecto (o la del chat) y si el proyecto usa worktrees. */
export interface TargetPlace {
  path: string;
  /** El proyecto tiene `workspace`: worktrees y ramas `orq/…`. Sin él, se trabaja directo en la carpeta. */
  worktrees: boolean;
}

export type StorageReader = (dir: string) => Promise<ProjectStorage>;

/**
 * `remoto` es una URL o una ruta y no el nombre de un remoto: tiene esquema (`https://`), forma SCP (`git@host:ruta`),
 * forma `host.dominio/ruta` o es una ruta absoluta.
 */
export function isRemoteUrl(text: string): boolean {
  const s = text.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) return true;
  if (/^(?:[^@/\\\s]+@)?[^@:/\\\s]{2,}:(?!\/\/).+$/.test(s)) return true;
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\')) return true;
  return /^[^/\\\s]+\.[^/\\\s]+[\\/]\S/.test(s);
}

/** Destino listo para guardar: la URL saneada (sin usuario, token ni consulta) o el nombre tachado. */
export function normalizeDestination(input: DestinationInput): ChangesDestination {
  const raw = input.remoto.trim();
  const remote = isRemoteUrl(raw) ? sanitizeRemoteUrl(raw) : redactSecrets(raw);
  if (!remote) throw new Error('el destino necesita un remoto o una URL');
  const branch = input.rama?.trim() ? redactSecrets(input.rama.trim()) : null;
  return { remote, branch };
}

/**
 * Resuelve el destino contra el git de la carpeta:
 * - sin destino: `local`, con `git` (`none`/`local`/`remote`) y `worktrees`;
 * - con el nombre de un remoto (`origin`): su URL saneada; `configured: false` si no está en `git remote`;
 * - con una URL: `configured` según coincida con algún remoto de la carpeta (y entonces `name` es el de ese remoto).
 * La rama es la indicada o, si no, la actual de la carpeta.
 */
export async function resolveChangesTarget(place: TargetPlace, destination: ChangesDestination | undefined, read: StorageReader = (dir) => readProjectStorage(dir)): Promise<ChangesTarget> {
  const storage = await read(place.path);
  if (!destination) return changesTargetSchema.parse({ kind: 'local', path: place.path, git: storage.kind, worktrees: place.worktrees });
  const branch = destination.branch ?? storage.branch;
  const wanted = destination.remote;
  const byName = storage.remotes.find((r) => r.name === wanted);
  let remote: { name: string | null; url: string };
  let configured: boolean;
  if (byName) {
    remote = { name: byName.name, url: sanitizeRemoteUrl(byName.url) };
    configured = true;
  } else if (isRemoteUrl(wanted)) {
    const match = storage.remotes.find((r) => sameRemoteUrl(r.url, wanted));
    remote = { name: match?.name ?? null, url: sanitizeRemoteUrl(wanted) };
    configured = match !== undefined;
  } else {
    remote = { name: wanted, url: '' };
    configured = false;
  }
  return changesTargetSchema.parse({ kind: 'remote', path: place.path, remote, branch, configured });
}

const rowSchema = z.object({ remote: z.string().min(1), branch: z.string().min(1).nullable() });

/** Tabla `chat_targets` sobre la conexión compartida del núcleo. */
export class ChatTargets {
  readonly #db: ChatDb;

  constructor(db: ChatDb) {
    this.#db = db;
    db.db.exec(CHAT_TARGET_SCHEMA);
  }

  /** Destino guardado del chat; `undefined` sin destino (o con una fila que no valida: se queda en local). */
  get(chatId: string): ChangesDestination | undefined {
    const raw = this.#db.stmt('SELECT remote, branch FROM chat_targets WHERE chat_id = ?').get(chatId);
    if (raw === undefined) return undefined;
    const row = rowSchema.safeParse(raw);
    return row.success ? { remote: row.data.remote, branch: row.data.branch } : undefined;
  }

  /** Guarda el destino (tachado otra vez antes de persistir). */
  set(chatId: string, destination: ChangesDestination, at: string): void {
    this.#db
      .stmt(
        `INSERT INTO chat_targets (chat_id, remote, branch, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET remote = excluded.remote, branch = excluded.branch, updated_at = excluded.updated_at`,
      )
      .run(chatId, redactSecrets(destination.remote), destination.branch === null ? null : redactSecrets(destination.branch), at);
  }

  /** Vuelve a local. Devuelve si había un destino. */
  clear(chatId: string): boolean {
    return Number(this.#db.stmt('DELETE FROM chat_targets WHERE chat_id = ?').run(chatId).changes) > 0;
  }
}
