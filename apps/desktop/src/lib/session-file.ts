import { z } from 'zod';
import { TOKEN_RE } from './ready-line.ts';

/**
 * Cifrador del archivo de sesión. En la app es `safeStorage` de Electron (en Windows, DPAPI del usuario
 * protege la clave AES de `Local State`); en las pruebas, uno falso.
 */
export interface Cipher {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Núcleo lanzado por la app: lo que hace falta para reutilizarlo al volver a abrirla y para apagarlo. */
export interface CoreSession {
  port: number;
  pid: number;
  token: string;
  startedAt: string;
}

export const SESSION_KIND = 'orq-desktop-session';
const MAX_SECRET_B64 = 16 * 1024;

const portSchema = z.number().int().min(1).max(65535);
/** En claro solo va lo que no sirve para hablar con el núcleo. */
const fileSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal(SESSION_KIND),
  launchedBy: z.literal('desktop'),
  port: portSchema,
  startedAt: z.iso.datetime(),
  cipher: z.literal('safeStorage'),
  /** `{token, pid, port}` cifrado (base64). El pid va dentro para que nadie lo cambie y la app mate otro proceso. */
  secret: z.base64().max(MAX_SECRET_B64),
});
const secretSchema = z.strictObject({
  token: z.string().regex(TOKEN_RE),
  pid: z.number().int().positive(),
  port: portSchema,
});

export function encodeSession(session: CoreSession, cipher: Cipher): string {
  const secret = cipher.encrypt(JSON.stringify({ token: session.token, pid: session.pid, port: session.port }));
  const file: z.infer<typeof fileSchema> = {
    v: 1,
    kind: SESSION_KIND,
    launchedBy: 'desktop',
    port: session.port,
    startedAt: session.startedAt,
    cipher: 'safeStorage',
    secret: secret.toString('base64'),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Lee el archivo de sesión. Cualquier problema (formato, descifrado, puertos distintos) da `null`. */
export function decodeSession(text: string, cipher: Cipher): CoreSession | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const file = fileSchema.safeParse(raw);
  if (!file.success) return null;
  let secret: unknown;
  try {
    secret = JSON.parse(cipher.decrypt(Buffer.from(file.data.secret, 'base64')));
  } catch {
    return null;
  }
  const inner = secretSchema.safeParse(secret);
  if (!inner.success || inner.data.port !== file.data.port) return null;
  return { port: file.data.port, pid: inner.data.pid, token: inner.data.token, startedAt: file.data.startedAt };
}
