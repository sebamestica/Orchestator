import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { redactSecrets } from '../../shared/index.ts';
import { lockNameSchema, RELEASING_MARK, releasingLockName } from './names.ts';
import {
  decodeOwnerFile, describeHolder, encodeOwner, hashLockToken, lockOwnerInputSchema, lockTokenSchema, newLockToken, skillIdentitySchema, tokenMatches,
} from './owner.ts';
import type { LockHolder, LockIdentity, LockOwner, LockOwnerInput } from './owner.ts';

type OwnerFile = ReturnType<typeof decodeOwnerFile>;

export const OWNER_FILE = 'owner';
const HOUR_MS = 3_600_000;
/** Errores de Windows mientras otra carpeta-candado se está borrando (delete pending). */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TRANSIENT_RETRIES = 5;

/** `conflict`: el candado cambió de dueño durante la liberación y la carpeta ajena no se pudo devolver (no se borró nada). */
export type LockErrorCode = 'invalid_name' | 'invalid_owner' | 'invalid_option' | 'busy' | 'timeout' | 'aborted' | 'not_held' | 'not_owner' | 'conflict';

export class LockError extends Error {
  readonly code: LockErrorCode;
  /** Candado afectado (o lista separada por comas si se pidió cualquiera de varios). */
  readonly lock: string;
  /** Dueño actual cuando se conoce (`busy`, `timeout`, `not_owner`). */
  readonly holder: LockHolder | undefined;
  constructor(code: LockErrorCode, lock: string, message: string, holder?: LockHolder, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LockError';
    this.code = code;
    this.lock = lock;
    this.holder = holder;
  }
}

/** Operaciones de disco que usa el gestor. Inyectables para reproducir carreras en pruebas. */
export interface LockFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true; maxRetries: number; retryDelay: number }): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; mtimeMs: number }>;
  writeFile(path: string, data: string, options: { flag: 'wx' }): Promise<void>;
}
const nodeFs: LockFs = { mkdir, readdir, readFile, rename, rm, stat, writeFile };

export interface LockManagerOptions {
  /** Carpeta de candados (absoluta). Por defecto `defaultLocksRoot()`. */
  root?: string;
  /** Sistema de archivos (pruebas); lo que falte usa `node:fs/promises`. */
  fs?: Partial<LockFs>;
  /** Reloj para la fecha del dueño y la antigüedad (pruebas). La espera usa el reloj real. */
  now?: () => Date;
  pid?: number;
  host?: string;
}

export interface AcquireOptions {
  /**
   * Tope de espera si está ocupado. 0 (por defecto) falla de inmediato con `busy`, como pide la skill
   * («recurso ocupado: hacer otra tarea y reintentar más tarde»). Con espera, al agotarse: `timeout`.
   */
  timeoutMs?: number;
  /** Pausa entre reintentos; se le suma ±25 % al azar para que los que esperan no choquen. Por defecto 1000 ms. */
  retryMs?: number;
  signal?: AbortSignal;
}

export interface LockHandle {
  readonly name: string;
  readonly path: string;
  readonly owner: LockOwner;
  /**
   * Prueba de propiedad de esta adquisición (en `owner` solo queda su SHA-256). Quien la tenga puede
   * liberar el candado, también desde otro proceso: no registrarla ni pasarla a quien no deba liberar.
   */
  readonly token: string;
  release(): Promise<void>;
}

/** Con qué se libera un candado del núcleo: su token o el `LockHandle` de la adquisición. */
export type LockReleaseProof = string | { readonly token: string };

export interface LockInfo {
  name: string;
  path: string;
  holder: LockHolder;
  /** Desde cuándo está tomado: `at` del dueño o, si falta, la fecha de modificación de la carpeta. */
  since: string;
  ageMs: number;
  /**
   * Carpeta apartada por una liberación (`<nombre>.releasing.…`): dura milisegundos, salvo que una devolución
   * chocara con un dueño nuevo (`conflict`). En ese caso queda aquí a la vista, sin borrar, para que A0 decida.
   */
  releasing?: true;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function validName(name: string): string {
  const parsed = lockNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new LockError('invalid_name', String(name), `Nombre de candado inválido «${String(name)}»: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

function validOwner(owner: LockOwnerInput, lock: string): { agent: string; task: string; note?: string } {
  const parsed = lockOwnerInputSchema.safeParse(owner);
  if (!parsed.success) throw new LockError('invalid_owner', lock, `Dueño inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const { agent, task, note } = parsed.data;
  return note === undefined ? { agent, task } : { agent, task, note: redactSecrets(note) };
}

function validToken(proof: LockReleaseProof, lock: string): string {
  const token: unknown = typeof proof === 'object' && proof !== null ? proof.token : proof;
  const parsed = lockTokenSchema.safeParse(token);
  if (!parsed.success) throw new LockError('invalid_owner', lock, `Para liberar ${lock} hace falta el token de la adquisición (o su LockHandle)`);
  return parsed.data;
}

function validSkillIdentity(identity: LockIdentity, lock: string): LockIdentity {
  const parsed = skillIdentitySchema.safeParse(identity);
  if (!parsed.success) throw new LockError('invalid_owner', lock, `Dueño inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

function nonNegative(value: number, label: string, lock: string): number {
  if (!Number.isFinite(value) || value < 0) throw new LockError('invalid_option', lock, `${label} debe ser un número finito ≥ 0`);
  return value;
}

/** `C:\dev\agent-hub\locks` en Windows, `/mnt/c/dev/agent-hub/locks` en WSL; `ORQ_LOCKS_ROOT` lo reemplaza. */
export function defaultLocksRoot(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = env.ORQ_LOCKS_ROOT?.trim();
  if (fromEnv) return fromEnv;
  return platform === 'win32' ? 'C:\\dev\\agent-hub\\locks' : '/mnt/c/dev/agent-hub/locks';
}

/**
 * Candados por carpeta compatibles con la skill `local-compute-scheduling`: tomar = `mkdir` atómico
 * (falla si existe, en Windows y en WSL) + archivo `owner`; liberar = borrar la carpeta propia.
 * Nunca borra candados ajenos ni viejos: `listStale` solo los informa.
 */
export class LockManager {
  readonly root: string;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly host: string;
  private readonly fs: LockFs;

  constructor(options: LockManagerOptions = {}) {
    const root = options.root ?? defaultLocksRoot();
    if (!isAbsolute(root)) throw new LockError('invalid_option', '', `La raíz de candados debe ser absoluta: ${root}`);
    this.root = root;
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? hostname();
    this.fs = { ...nodeFs, ...options.fs };
  }

  pathOf(name: string): string {
    return join(this.root, validName(name));
  }

  /** Toma el candado o lanza `LockError` (`busy` sin espera, `timeout` si se agotó la espera, `aborted`). */
  acquire(name: string, owner: LockOwnerInput, options: AcquireOptions = {}): Promise<LockHandle> {
    return this.acquireFirst([name], owner, options);
  }

  /** Toma el primero libre de varios candados equivalentes (p. ej. `LOCK_POOLS['heavy-cpu']`). */
  acquireAny(names: readonly string[], owner: LockOwnerInput, options: AcquireOptions = {}): Promise<LockHandle> {
    return this.acquireFirst(names, owner, options);
  }

  /**
   * Libera un candado del núcleo. Exige el token de la adquisición (o su handle): conocer agente y tarea,
   * que salen en los errores `busy`, no basta. Token ajeno o de otra adquisición: `not_owner`; libre: `not_held`.
   */
  async release(name: string, proof: LockReleaseProof): Promise<void> {
    const lock = validName(name);
    const token = validToken(proof, lock);
    await this.releaseWhen(lock, (owner) => owner.holder.format === 'json' && tokenMatches(token, owner.tokenHash),
      (holder) => `Ese token no es el de la adquisición vigente de ${lock}: lo tiene ${describeHolder(holder)}`);
  }

  /**
   * Liberación de mantenimiento, solo para candados en texto de la skill (`<agente> <tarea> <fecha>`), que no
   * tienen token: exige agente y tarea exactos. Nunca libera un candado del núcleo ni uno ilegible.
   */
  async releaseSkillLock(name: string, identity: LockIdentity): Promise<void> {
    const lock = validName(name);
    const who = validSkillIdentity(identity, lock);
    await this.releaseWhen(lock, ({ holder }) => holder.format === 'text' && holder.agent === who.agent && holder.task === who.task,
      (holder) => holder.format === 'json'
        ? `${lock} es un candado del núcleo (${describeHolder(holder)}): se libera con su token, no por agente y tarea`
        : `${who.agent}/${who.task} no puede liberar ${lock}: lo tiene ${describeHolder(holder)}`);
  }

  /**
   * Ejecuta `fn` con el candado y lo libera siempre. Si `fn` lanza, se relanza su error;
   * si además falla la liberación, se lanza un `AggregateError` con ambos.
   * Un candado que ya no existe al terminar (alguien lo borró a mano) no es error.
   */
  async withLock<T>(name: string | readonly string[], owner: LockOwnerInput, fn: (lock: LockHandle) => Promise<T> | T, options: AcquireOptions = {}): Promise<T> {
    const handle = await this.acquireFirst(typeof name === 'string' ? [name] : name, owner, options);
    let result: T;
    try {
      result = await fn(handle);
    } catch (error) {
      try {
        await this.releaseHeld(handle);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], `La tarea con el candado ${handle.name} falló y no se pudo liberar`);
      }
      throw error;
    }
    await this.releaseHeld(handle);
    return result;
  }

  /** Estado de un candado, o `undefined` si está libre. */
  async read(name: string): Promise<LockInfo | undefined> {
    const lock = validName(name);
    return this.inspect(lock, join(this.root, lock));
  }

  private async inspect(lock: string, path: string, releasing = false): Promise<LockInfo | undefined> {
    let info: Awaited<ReturnType<LockFs['stat']>>;
    try {
      info = await this.fs.stat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    const holder = info.isDirectory() ? (await this.readOwnerAt(path)).holder : { format: 'invalid' as const, raw: 'no es una carpeta' };
    // Con fecha sin hora (`date -I`) la de la carpeta es más precisa que el día.
    const at = holder.at?.includes('T') ? Date.parse(holder.at) : Number.NaN;
    const sinceMs = Number.isFinite(at) ? at : info.mtimeMs;
    const base = { name: lock, path, holder, since: new Date(sinceMs).toISOString(), ageMs: Math.max(0, this.now().getTime() - sinceMs) };
    return releasing ? { ...base, releasing: true } : base;
  }

  /** Candados tomados y carpetas apartadas por liberaciones, por nombre de carpeta. Ignora el resto. */
  async list(): Promise<LockInfo[]> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.root);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const infos = await Promise.all(names.sort().map((entry) => {
      if (lockNameSchema.safeParse(entry).success) return this.inspect(entry, join(this.root, entry));
      const lock = releasingLockName(entry);
      return lock ? this.inspect(lock, join(this.root, entry), true) : undefined;
    }));
    return infos.filter((info) => info !== undefined);
  }

  /** Candados con más de `hours` horas (por defecto 3, regla de la skill). No los borra: avisar a A0 o al usuario. */
  async listStale(hours = 3): Promise<LockInfo[]> {
    const limit = nonNegative(hours, 'hours', '') * HOUR_MS;
    return (await this.list()).filter((info) => info.ageMs > limit);
  }

  private async readOwnerAt(path: string): Promise<OwnerFile> {
    try {
      return decodeOwnerFile(await this.fs.readFile(join(path, OWNER_FILE)));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return { holder: { format: 'missing' } };
      // Windows: `owner` en pleno borrado o bloqueado por otro proceso.
      if (code && TRANSIENT.has(code)) return { holder: { format: 'invalid', raw: `owner ilegible (${code})` } };
      throw error;
    }
  }

  /**
   * Libera `lock` si `isMine` acepta su owner; si no, `not_owner` con el mensaje de `refusal`.
   * Leer y borrar no es atómico (otro pudo tomar el candado entre ambos pasos), así que se aparta primero
   * la carpeta con `rename`, que sí lo es, y se confirma el dueño sobre lo apartado antes de borrar.
   */
  private async releaseWhen(lock: string, isMine: (owner: OwnerFile) => boolean, refusal: (holder: LockHolder) => string): Promise<void> {
    const path = join(this.root, lock);
    const notHeld = () => new LockError('not_held', lock, `El candado ${lock} no está tomado`);
    // 1. Comprobación previa sin tocar nada: un token o un dueño equivocados nunca mueven la carpeta ajena.
    try {
      await this.fs.stat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw notHeld();
      throw error;
    }
    const current = await this.readOwnerAt(path);
    if (!isMine(current)) throw new LockError('not_owner', lock, refusal(current.holder), current.holder);
    // 2. Apartar: si el rename falla con ENOENT, ya no es nuestro (lo liberó otra llamada).
    const aside = join(this.root, `${lock}${RELEASING_MARK}${this.pid}.${randomBytes(4).toString('hex')}`);
    try {
      await this.renameRetrying(path, aside);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw notHeld();
      throw error;
    }
    // 3. Confirmar sobre lo apartado: si cambió de dueño entre 1 y 2, lo apartado es del dueño nuevo.
    const moved = await this.readOwnerAt(aside);
    if (isMine(moved)) {
      // `maxRetries` cubre EBUSY/EPERM/ENOTEMPTY de Windows si alguien está leyendo `owner`.
      await this.fs.rm(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    }
    // 4. No era nuestro: devolverlo a su nombre. En Windows, rename nunca reemplaza una carpeta existente, así que si
    // alguien ya tomó el nombre falla y no se pisa a nadie (en POSIX reemplazaría una carpeta recién creada y vacía).
    try {
      await this.fs.rename(aside, path);
    } catch (error) {
      throw new LockError('conflict', lock,
        `El candado ${lock} cambió de dueño durante la liberación y ya tiene otro: la carpeta de ${describeHolder(moved.holder)} `
        + `quedó apartada en ${aside}. No se borró nada; avisar a A0`, moved.holder, { cause: error });
    }
    throw new LockError('not_owner', lock, refusal(moved.holder), moved.holder);
  }

  /** rename con reintentos ante los errores pasajeros de Windows (antivirus, un lector con `owner` abierto). */
  private async renameRetrying(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fs.rename(from, to);
        return;
      } catch (error) {
        const code = errorCode(error);
        if (!code || !TRANSIENT.has(code) || attempt >= TRANSIENT_RETRIES) throw error;
        await sleep(20 * (attempt + 1));
      }
    }
  }

  private async releaseHeld(handle: LockHandle): Promise<void> {
    try {
      await handle.release();
    } catch (error) {
      if (!(error instanceof LockError && error.code === 'not_held')) throw error;
    }
  }

  private async acquireFirst(names: readonly string[], owner: LockOwnerInput, options: AcquireOptions): Promise<LockHandle> {
    const locks = [...new Set(names.map(validName))];
    const label = locks.join(',');
    if (!locks.length) throw new LockError('invalid_name', '', 'Falta el nombre del candado');
    const who = validOwner(owner, label);
    const timeoutMs = nonNegative(options.timeoutMs ?? 0, 'timeoutMs', label);
    const retryMs = nonNegative(options.retryMs ?? 1000, 'retryMs', label);
    const aborted = () => new LockError('aborted', label, `Espera del candado ${label} cancelada`, undefined, { cause: options.signal?.reason });
    const started = performance.now();
    await this.fs.mkdir(this.root, { recursive: true });
    for (;;) {
      if (options.signal?.aborted) throw aborted();
      for (const lock of locks) {
        const handle = await this.tryAcquire(lock, who);
        if (handle) return handle;
      }
      const elapsed = performance.now() - started;
      if (elapsed >= timeoutMs) {
        const holder = (await this.read(locks[0] ?? '').catch(() => undefined))?.holder;
        const by = holder ? describeHolder(holder) : 'otro dueño';
        throw timeoutMs > 0
          ? new LockError('timeout', label, `Candado ${label} ocupado tras esperar ${Math.round(elapsed)} ms (${by})`, holder)
          : new LockError('busy', label, `Candado ${label} ocupado por ${by}`, holder);
      }
      const pause = Math.min(timeoutMs - elapsed, retryMs * (0.75 + Math.random() * 0.5));
      try {
        await sleep(Math.max(1, pause), undefined, { signal: options.signal });
      } catch {
        throw aborted();
      }
    }
  }

  /** Un intento: `mkdir` no recursivo es la operación atómica; quien lo logra escribe `owner`. */
  private async tryAcquire(lock: string, who: { agent: string; task: string; note?: string }): Promise<LockHandle | undefined> {
    const path = join(this.root, lock);
    const owner: LockOwner = { ...who, pid: this.pid, host: this.host, at: this.now().toISOString() };
    const token = newLockToken();
    const content = encodeOwner({ ...owner, tokenHash: hashLockToken(token) });
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fs.mkdir(path);
        break;
      } catch (error) {
        const code = errorCode(error);
        if (code === 'EEXIST') return undefined;
        if (!code || !TRANSIENT.has(code)) throw error;
        // Windows: la carpeta del dueño anterior se está borrando («delete pending») o un antivirus la tiene
        // abierta. Solo hay dueño si su owner se puede leer; si no, reintentar con espera creciente.
        const { holder } = await this.readOwnerAt(path);
        if (holder.format === 'json' || holder.format === 'text') return undefined;
        if (attempt >= TRANSIENT_RETRIES) throw error;
        await sleep(20 * (attempt + 1));
      }
    }
    try {
      // Escritura + rename: quien lea `owner` nunca ve un JSON a medias.
      const temp = join(path, `.${OWNER_FILE}-${this.pid}-${randomBytes(4).toString('hex')}.tmp`);
      await this.fs.writeFile(temp, content, { flag: 'wx' });
      await this.fs.rename(temp, join(path, OWNER_FILE));
    } catch (error) {
      await this.fs.rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
      throw error;
    }
    return { name: lock, path, owner, token, release: () => this.release(lock, token) };
  }
}
