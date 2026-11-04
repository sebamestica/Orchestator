import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { idSchema, redactSecrets } from '../../shared/index.ts';

const isoDate = z.iso.datetime({ offset: true });
/** Fecha del owner en texto: `date -Is` / `Get-Date -Format o` (con hora) o `date -I` (solo el día). */
const skillDate = z.union([isoDate, z.iso.date()]);
const MAX_RAW = 500;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const normalizeSpaces = (text: string) => text.trim().split(/\s+/).join(' ');

/**
 * Contenido JSON del archivo `owner` que escribe el núcleo (una línea, legible con `cat`).
 * `at` admite zona horaria (`date -Is`, `Get-Date -Format o`) o UTC (`toISOString`).
 */
export const lockOwnerSchema = z.object({
  agent: idSchema,
  task: idSchema,
  pid: z.number().int().positive(),
  host: z.string().min(1).max(255),
  at: isoDate,
  /** Qué se ejecuta con el recurso (p. ej. el comando), ya redactado. */
  note: z.string().max(MAX_RAW).optional(),
  /** SHA-256 del token de esta adquisición. El token solo lo tiene quien tomó el candado. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
});
/** Dueño tal como lo ve cualquiera: sin el hash del token. */
export type LockOwner = Omit<z.infer<typeof lockOwnerSchema>, 'tokenHash'>;

/** Token de liberación: 128 bits al azar por adquisición, en hexadecimal. */
export const lockTokenSchema = z.string().regex(/^[0-9a-f]{32}$/);

export function newLockToken(): string {
  return randomBytes(16).toString('hex');
}

export function hashLockToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compara en tiempo constante el token con el hash guardado en `owner`. */
export function tokenMatches(token: string, tokenHash: string | undefined): boolean {
  if (!tokenHash) return false;
  const expected = Buffer.from(tokenHash, 'hex');
  const actual = Buffer.from(hashLockToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Lo que indica quien toma el candado; pid, host y fecha los completa el gestor. */
export const lockOwnerInputSchema = z.object({
  agent: idSchema,
  task: idSchema,
  note: z.string().max(MAX_RAW).optional(),
});
export type LockOwnerInput = z.input<typeof lockOwnerInputSchema>;

/**
 * Agente + tarea de un candado en texto de la skill, para la liberación de mantenimiento
 * (`releaseSkillLock`). Los candados del núcleo se liberan con su token, nunca así.
 */
export const skillIdentitySchema = z.object({
  /** Primera palabra del owner: sin espacios. */
  agent: z.string().regex(/^\S{1,64}$/).refine((agent) => !CONTROL.test(agent), 'sin caracteres de control'),
  /** El resto: puede tener espacios; se normalizan igual que al leer el owner. */
  task: z.string().transform(normalizeSpaces).pipe(z.string().min(1).max(200).refine((task) => !CONTROL.test(task), 'sin caracteres de control')),
});
export interface LockIdentity {
  agent: string;
  task: string;
}

/**
 * Dueño tal como se leyó del disco.
 * - `json`: formato del núcleo (`lockOwnerSchema`).
 * - `text`: convención de la skill, `<agente> <tarea> <fecha ISO>` (bash: `echo … $(date -Is) > owner`).
 * - `missing`: carpeta sin `owner` (recién creada o el dueño murió antes de escribirlo).
 * - `invalid`: no se pudo interpretar; `raw` trae el inicio, redactado.
 */
export interface LockHolder {
  format: 'json' | 'text' | 'missing' | 'invalid';
  agent?: string;
  task?: string;
  pid?: number;
  host?: string;
  at?: string;
  note?: string;
  raw?: string;
}

export function encodeOwner(owner: z.input<typeof lockOwnerSchema>): string {
  return `${JSON.stringify(lockOwnerSchema.parse(owner))}\n`;
}

/** UTF-8 (con o sin BOM) o UTF-16 LE con BOM, que es lo que escribe `>`/`Out-File` en Windows PowerShell 5.1. */
function decodeText(bytes: Uint8Array): string {
  // TextDecoder quita el BOM por su cuenta (ignoreBOM = false).
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

function clip(text: string): string {
  return redactSecrets(text.length > MAX_RAW ? `${text.slice(0, MAX_RAW)}…` : text);
}

function parseLegacy(text: string): LockHolder | undefined {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  // eslint-disable-next-line no-control-regex
  if (!line || line.startsWith('{') || /[\u0000-\u0008\u000e-\u001f]/.test(line)) return undefined;
  const tokens = line.split(/\s+/);
  const last = tokens.at(-1);
  const at = tokens.length >= 2 && last !== undefined && skillDate.safeParse(last).success ? last : undefined;
  const [agent, ...task] = at ? tokens.slice(0, -1) : tokens;
  return {
    format: 'text',
    ...(agent ? { agent } : {}),
    ...(task.length ? { task: redactSecrets(task.join(' ')) } : {}),
    ...(at ? { at } : {}),
    raw: clip(line),
  };
}

/** Interpreta `owner` y separa el hash del token, que no sale del gestor. Nunca lanza. */
export function decodeOwnerFile(bytes: Uint8Array): { holder: LockHolder; tokenHash?: string } {
  const text = decodeText(bytes).trim();
  if (!text) return { holder: { format: 'missing' } };
  if (text.startsWith('{')) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return { holder: { format: 'invalid', raw: clip(text) } }; }
    const parsed = lockOwnerSchema.safeParse(value);
    if (!parsed.success) return { holder: { format: 'invalid', raw: clip(text) } };
    const { tokenHash, ...owner } = parsed.data;
    return { holder: { format: 'json', ...owner }, tokenHash };
  }
  return { holder: parseLegacy(text) ?? { format: 'invalid', raw: clip(text) } };
}

/** Interpreta el archivo `owner`: JSON del núcleo o texto de la skill. Nunca lanza. */
export function decodeOwner(bytes: Uint8Array): LockHolder {
  return decodeOwnerFile(bytes).holder;
}

export function describeHolder(holder: LockHolder): string {
  if (holder.format === 'missing') return 'dueño desconocido (sin archivo owner)';
  if (!holder.agent) return `dueño ilegible (${holder.raw ?? ''})`;
  const where = holder.pid ? ` pid ${holder.pid}${holder.host ? ` en ${holder.host}` : ''}` : '';
  return `${holder.agent}/${holder.task ?? '?'}${where}${holder.at ? ` desde ${holder.at}` : ''}`;
}
