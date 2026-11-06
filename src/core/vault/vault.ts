import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { idSchema } from '../../shared/index.ts';
import { renameWithRetry, retryWhileBusy } from '../memory/safe-fs.ts';
import { VaultError, type Cipher } from './dpapi.ts';
import { FileLockBusyError, withFileLock, type FileLockOptions } from './file-lock.ts';

/** Referencia a un secreto: lo único que sale de la bóveda además del valor pedido con `get`. */
export interface SecretRefInfo {
  ref: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

/** Bóveda de claves. `list` nunca devuelve valores. */
export interface SecretVault {
  set(ref: string, value: string, meta?: { label?: string }): Promise<SecretRefInfo>;
  get(ref: string): Promise<string | undefined>;
  delete(ref: string): Promise<boolean>;
  list(): Promise<SecretRefInfo[]>;
}

const labelSchema = z.string().min(1).max(120);
const entrySchema = z.strictObject({
  protected: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  label: labelSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const fileSchema = z.strictObject({
  version: z.literal(1),
  scheme: z.literal('dpapi-currentuser'),
  entries: z.record(idSchema, entrySchema),
});
type VaultFile = z.infer<typeof fileSchema>;

/** Cabecera mínima para distinguir un archivo de otra versión de Berland (no es daño) de uno roto. */
const headerSchema = z.looseObject({ version: z.number(), scheme: z.string().optional() });

/** Lo que hay en un archivo de bóveda. `foreign`: JSON válido con `version` o `scheme` que esta versión no conoce. */
type FileState = { kind: 'ok'; file: VaultFile } | { kind: 'missing' } | { kind: 'damaged'; reason: string } | { kind: 'foreign' };

/** Contenido leído y si `vault.json` estaba sano (solo entonces se copia a `.bak` antes de reemplazarlo). */
interface Loaded {
  file: VaultFile;
  mainIsSound: boolean;
}

const emptyFile = (): VaultFile => ({ version: 1, scheme: 'dpapi-currentuser', entries: {} });

export interface FileVaultOptions {
  /** `%LOCALAPPDATA%\orquestador\vault.json` en producción; un temporal en pruebas. */
  path: string;
  cipher: Cipher;
  /** Registro de operaciones (solo referencias, nunca valores). */
  log?: (line: string) => void;
  now?: () => Date;
  /** Candado entre procesos (`<path>.lock`) durante leer → modificar → reemplazar. */
  lock?: FileLockOptions;
}

const valueSchema = z.string().min(1).max(16_384);

function checkRef(ref: string): string {
  const parsed = idSchema.safeParse(ref);
  if (!parsed.success) throw new VaultError('Referencia de secreto inválida');
  return parsed.data;
}

/**
 * Bóveda en un archivo JSON con los valores cifrados (DPAPI). Escrituras atómicas (temporal con flush + rename
 * con reintentos) y copia del archivo sano anterior en `<path>.bak`. Si `<path>` está dañado se lee la copia;
 * si tampoco sirve, `set` aparta el dañado como `<path>.danada-<fecha>` y empieza una bóveda vacía.
 * Cada lectura-modificación-reemplazo va en serie dentro del proceso y con un candado entre procesos
 * (`<path>.lock`, `mkdir` atómico), para que dos instancias sobre el mismo archivo no pierdan cambios.
 * El cifrado y descifrado (PowerShell, ~0,5 s) se hacen fuera del candado.
 */
export class FileVault implements SecretVault {
  private readonly opts: FileVaultOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: FileVaultOptions) {
    this.opts = opts;
  }

  async set(ref: string, value: string, meta: { label?: string } = {}): Promise<SecretRefInfo> {
    const id = checkRef(ref);
    if (!valueSchema.safeParse(value).success) throw new VaultError('Valor de secreto vacío o demasiado largo');
    if (meta.label !== undefined && !labelSchema.safeParse(meta.label).success) throw new VaultError('Etiqueta de secreto vacía o demasiado larga');
    const label = meta.label;
    const protectedB64 = await this.opts.cipher.protect(value);
    return this.locked(async () => {
      const { file, mainIsSound } = await this.read({ repair: true });
      const ts = this.iso();
      const prev = file.entries[id];
      const entry = { protected: protectedB64, createdAt: prev?.createdAt ?? ts, updatedAt: ts, ...(label ?? prev?.label ? { label: label ?? prev?.label } : {}) };
      file.entries[id] = entrySchema.parse(entry);
      await this.write(file, mainIsSound);
      this.log(`vault set ${id}`);
      return info(id, file.entries[id]);
    });
  }

  async get(ref: string): Promise<string | undefined> {
    const id = checkRef(ref);
    const entry = await this.locked(async () => (await this.read()).file.entries[id]);
    if (!entry) return undefined;
    this.log(`vault get ${id}`);
    return this.opts.cipher.unprotect(entry.protected);
  }

  async delete(ref: string): Promise<boolean> {
    const id = checkRef(ref);
    return this.locked(async () => {
      const { file, mainIsSound } = await this.read();
      if (!file.entries[id]) return false;
      file.entries = Object.fromEntries(Object.entries(file.entries).filter(([k]) => k !== id));
      await this.write(file, mainIsSound);
      this.log(`vault delete ${id}`);
      return true;
    });
  }

  list(): Promise<SecretRefInfo[]> {
    return this.locked(async () => {
      const { file } = await this.read();
      return Object.entries(file.entries)
        .map(([id, e]) => info(id, e))
        .sort((a, b) => a.ref.localeCompare(b.ref));
    });
  }

  /** En serie dentro del proceso y con el candado entre procesos. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      try {
        return await withFileLock(`${this.opts.path}.lock`, fn, this.opts.lock);
      } catch (err) {
        if (err instanceof FileLockBusyError) throw new VaultError('La bóveda está ocupada por otro proceso; reintenta en unos segundos');
        if (err instanceof VaultError) throw err;
        throw new VaultError(`No se pudo bloquear la bóveda (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Lee `<path>`; si está dañado, la copia `<path>.bak`. Con `repair` (solo `set`) y sin copia útil, aparta el
   * dañado y devuelve una bóveda vacía. Un archivo de otra versión nunca se trata como daño.
   */
  private async read(opts: { repair?: boolean } = {}): Promise<Loaded> {
    const main = await readVaultFile(this.opts.path);
    if (main.kind === 'ok') return { file: main.file, mainIsSound: true };
    if (main.kind === 'missing') return { file: emptyFile(), mainIsSound: false };
    if (main.kind === 'foreign') throw new VaultError('La bóveda es de otra versión de Berland (versión o esquema desconocido)');
    const backup = await readVaultFile(`${this.opts.path}.bak`);
    if (backup.kind === 'ok') {
      this.log('vault recuperada desde la copia (.bak)');
      return { file: backup.file, mainIsSound: false };
    }
    if (!opts.repair) throw new VaultError(main.reason);
    const aside = `${this.opts.path}.danada-${this.iso().replace(/[:.]/g, '-')}`;
    try {
      await renameWithRetry(this.opts.path, aside);
    } catch (err) {
      throw new VaultError(`No se pudo apartar la bóveda dañada (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    this.log(`vault dañada apartada como ${basename(aside)}; se empieza una vacía`);
    return { file: emptyFile(), mainIsSound: false };
  }

  /** Temporal con flush, copia del archivo sano anterior en `.bak` y reemplazo con reintentos ante el antivirus. */
  private async write(file: VaultFile, mainIsSound: boolean): Promise<void> {
    await mkdir(dirname(this.opts.path), { recursive: true });
    const tmp = `${this.opts.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flush: true });
      if (mainIsSound) await retryWhileBusy(() => copyFile(this.opts.path, `${this.opts.path}.bak`));
      await renameWithRetry(tmp, this.opts.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw new VaultError(`No se pudo escribir la bóveda (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private iso(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
}

/** Lee y valida un archivo de bóveda sin lanzar por daño; solo lanza si no se puede leer (salvo ENOENT). */
async function readVaultFile(path: string): Promise<FileState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw new VaultError(`No se pudo leer la bóveda (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: 'damaged', reason: 'La bóveda está dañada (JSON inválido)' };
  }
  const parsed = fileSchema.safeParse(data);
  if (parsed.success) return { kind: 'ok', file: parsed.data };
  const head = headerSchema.safeParse(data);
  if (head.success && (head.data.version !== 1 || (head.data.scheme !== undefined && head.data.scheme !== 'dpapi-currentuser'))) return { kind: 'foreign' };
  return { kind: 'damaged', reason: 'La bóveda está dañada (formato inválido)' };
}

function info(ref: string, e: z.infer<typeof entrySchema>): SecretRefInfo {
  return { ref, ...(e.label ? { label: e.label } : {}), createdAt: e.createdAt, updatedAt: e.updatedAt };
}

/** Bóveda en memoria (pruebas y desarrollo fuera de Windows). No persiste nada. */
export class MemoryVault implements SecretVault {
  private readonly entries = new Map<string, { value: string; info: SecretRefInfo }>();

  async set(ref: string, value: string, meta: { label?: string } = {}): Promise<SecretRefInfo> {
    const id = checkRef(ref);
    if (!valueSchema.safeParse(value).success) throw new VaultError('Valor de secreto vacío o demasiado largo');
    const ts = new Date().toISOString();
    const prev = this.entries.get(id)?.info;
    const label = meta.label ?? prev?.label;
    const entry: SecretRefInfo = { ref: id, ...(label ? { label } : {}), createdAt: prev?.createdAt ?? ts, updatedAt: ts };
    this.entries.set(id, { value, info: entry });
    return { ...entry };
  }

  async get(ref: string): Promise<string | undefined> {
    return this.entries.get(checkRef(ref))?.value;
  }

  async delete(ref: string): Promise<boolean> {
    return this.entries.delete(checkRef(ref));
  }

  async list(): Promise<SecretRefInfo[]> {
    return [...this.entries.values()].map((e) => ({ ...e.info })).sort((a, b) => a.ref.localeCompare(b.ref));
  }
}
