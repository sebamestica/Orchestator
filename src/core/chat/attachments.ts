/**
 * Adjuntos del chat: imágenes pegadas y archivos soltados.
 * - Subida (`POST /attachments?name=`): bytes crudos ≤ `MAX_ATTACHMENT_BYTES`, copia en `<dataDir>/attachments/<id>/<nombre saneado>`.
 *   Cada subida tiene su carpeta: abrirla a la mente no abre las de otros chats (`uploadRoot`). Las subidas antiguas
 *   quedaron en la carpeta común como `<id>-<nombre>`.
 * - Por ruta (`POST /attachments/by-path`): un archivo local que existe (Electron conoce la ruta real), sin copiarlo.
 * `kind`: `image` solo si los bytes son de verdad png, jpeg, gif o webp (firma); `text` para tipos de texto y
 * extensiones de código; `file` para el resto.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_ATTACHMENT_BYTES, attachmentSchema, opaqueIdSchema, redactSecrets } from '../../shared/index.ts';
import type { Attachment } from '../../shared/index.ts';
import type { ImageMediaType } from '../conductor/index.ts';
import { ChatDb, toAttachment } from './db.ts';

export type AttachmentErrorCode = 'invalid' | 'not_found' | 'too_large';
export class AttachmentError extends Error {
  override name = 'AttachmentError';
  readonly code: AttachmentErrorCode;
  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Firma de los formatos de imagen que acepta la API de Mensajes. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | undefined {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38 && (b(4) === 0x37 || b(4) === 0x39) && b(5) === 0x61) return 'image/gif';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  return undefined;
}

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-ndjson',
]);

const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown mdx rst log csv tsv json jsonc json5 ndjson yaml yml toml ini cfg conf properties env.example xml html htm css scss sass less ' +
    'js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi rb php java kt kts scala go rs c h cc cpp cxx hpp hh cs fs swift m mm dart lua r jl ' +
    'pl pm sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto gradle cmake make mk dockerfile tf hcl nix ex exs erl hs ml clj elm zig ' +
    'gitignore gitattributes editorconfig lock'
  ).split(' '),
);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  zip: 'application/zip',
};

function extensionOf(name: string): string {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base.replace(/^\./, '') : base.slice(dot + 1);
}

/** Tipo de texto o de código por su tipo MIME o su extensión. */
export function isTextual(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (TEXT_MIMES.has(mime) || /\+(?:json|xml)$/.test(mime)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

/** `Content-Type` sin parámetros, en minúsculas; inválido o ausente → `application/octet-stream`. */
export function normalizeMime(raw: string | undefined): string {
  const base = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,99}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,99}$/.test(base) ? base : 'application/octet-stream';
}

const FORBIDDEN_CHARS = '<>:"|?*\\/';
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Nombre de archivo seguro en Windows: sin rutas, caracteres prohibidos, nombres reservados ni puntos finales. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = [...redactSecrets(base.normalize('NFC'))]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch === '\u007f' || FORBIDDEN_CHARS.includes(ch) ? '_' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 20);
    name = `${name.slice(0, 120 - ext.length)}${ext}`;
  }
  return name || 'archivo';
}

export interface AttachmentStoreOptions {
  /** `store.database` del núcleo (o un `ChatDb` ya armado). */
  db: DatabaseSync | ChatDb;
  /** Carpeta de las copias (`<dataDir>/attachments`). */
  dir: string;
  now?: () => Date;
  newId?: () => string;
  /** Tope por adjunto (por defecto `MAX_ATTACHMENT_BYTES`). */
  maxBytes?: number;
}

const COLUMNS = 'id, name, mime, size, path, kind, source, created_at';

export class AttachmentStore {
  readonly dir: string;
  readonly maxBytes: number;
  readonly #db: ChatDb;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(opts: AttachmentStoreOptions) {
    this.#db = opts.db instanceof ChatDb ? opts.db : new ChatDb(opts.db);
    this.dir = path.resolve(opts.dir);
    this.maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.#now = opts.now ?? (() => new Date());
    this.#newId = opts.newId ?? randomUUID;
  }

  /** Guarda bytes subidos (imagen pegada o archivo soltado en la web). */
  async upload(input: { name: string; mime?: string; bytes: Uint8Array }): Promise<Attachment> {
    if (input.bytes.byteLength > this.maxBytes) throw new AttachmentError('too_large', `El adjunto supera el tope de ${mbText(this.maxBytes)}`);
    if (input.bytes.byteLength === 0) throw new AttachmentError('invalid', 'El adjunto está vacío');
    const name = sanitizeFileName(input.name);
    const sniffed = sniffImage(input.bytes);
    const declared = normalizeMime(input.mime);
    // Un tipo de imagen que no coincide con los bytes no se sirve como imagen.
    const mime = sniffed ?? (declared.startsWith('image/') ? 'application/octet-stream' : declared);
    // El id es el nombre de la carpeta: se valida antes de tocar el disco.
    const id = opaqueIdSchema.parse(this.#newId());
    const folder = path.join(this.dir, id);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, name);
    await writeFile(file, input.bytes, { flag: 'wx' });
    return this.#insert({ id, name, mime, size: input.bytes.byteLength, path: file, kind: kindOf(sniffed, mime, name), source: 'upload' });
  }

  /** Registra un archivo local que existe, sin copiarlo (Electron). */
  async registerPath(rawPath: string): Promise<Attachment> {
    if (!path.isAbsolute(rawPath)) throw new AttachmentError('invalid', 'La ruta del adjunto debe ser absoluta');
    if (rawPath.includes('\0')) throw new AttachmentError('invalid', 'Ruta inválida');
    const file = path.resolve(rawPath);
    if (redactSecrets(file) !== file) throw new AttachmentError('invalid', 'La ruta tiene forma de clave: no se registra');
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      throw new AttachmentError('not_found', 'No existe el archivo');
    }
    if (!info.isFile()) throw new AttachmentError('invalid', 'La ruta no es un archivo');
    if (info.size > this.maxBytes) throw new AttachmentError('too_large', `El archivo supera el tope de ${mbText(this.maxBytes)}`);
    const head = await readHead(file);
    const name = sanitizeFileName(path.basename(file));
    const sniffed = sniffImage(head);
    const byExt = MIME_BY_EXTENSION[extensionOf(name)];
    const mime = sniffed ?? (byExt && !byExt.startsWith('image/') ? byExt : isTextual('', name) ? 'text/plain' : 'application/octet-stream');
    return this.#insert({ id: this.#newId(), name, mime, size: info.size, path: file, kind: kindOf(sniffed, mime, name), source: 'path' });
  }

  get(id: string): Attachment | undefined {
    const raw = this.#db.stmt(`SELECT ${COLUMNS} FROM chat_attachments WHERE id = ?`).get(id);
    return raw ? toAttachment(raw) : undefined;
  }

  require(id: string): Attachment {
    const a = this.get(id);
    if (!a) throw new AttachmentError('not_found', `No existe el adjunto ${id}`);
    return a;
  }

  /** Bytes actuales del adjunto (un archivo por ruta puede haber cambiado: se vuelve a acotar). */
  async read(id: string): Promise<{ attachment: Attachment; bytes: Uint8Array }> {
    const attachment = this.require(id);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(attachment.path);
    } catch {
      throw new AttachmentError('not_found', `El archivo de «${attachment.name}» ya no existe`);
    }
    if (info.size > this.maxBytes) throw new AttachmentError('too_large', `«${attachment.name}» supera el tope de ${mbText(this.maxBytes)}`);
    return { attachment, bytes: new Uint8Array(await readFile(attachment.path)) };
  }

  /**
   * Raíz de lectura de un adjunto subido: su carpeta propia, o el archivo mismo si es una subida antigua de la carpeta
   * común (o de fuera de `dir`). Nunca la carpeta común: daría acceso a las subidas de todos los chats.
   */
  uploadRoot(a: Pick<Attachment, 'path'>): string {
    const folder = path.dirname(path.resolve(a.path));
    return path.dirname(folder) === this.dir ? folder : path.resolve(a.path);
  }

  /** Borra el registro y, si es una copia subida, su archivo (y su carpeta propia). */
  async remove(id: string): Promise<void> {
    const a = this.get(id);
    if (!a) return;
    this.#db.stmt('DELETE FROM chat_attachments WHERE id = ?').run(id);
    if (a.source !== 'upload' || !isInside(this.dir, a.path)) return;
    const root = this.uploadRoot(a);
    await rm(root, { recursive: root !== path.resolve(a.path), force: true });
  }

  #insert(fields: Omit<Attachment, 'createdAt'>): Attachment {
    const a = attachmentSchema.parse({ ...fields, createdAt: this.#now().toISOString() });
    this.#db
      .stmt(`INSERT INTO chat_attachments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.name, a.mime, a.size, a.path, a.kind, a.source, a.createdAt);
    return a;
  }
}

function kindOf(sniffed: ImageMediaType | undefined, mime: string, name: string): Attachment['kind'] {
  if (sniffed) return 'image';
  return isTextual(mime, name) ? 'text' : 'file';
}

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const buf = new Uint8Array(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function mbText(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
