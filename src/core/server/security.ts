import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from './errors.ts';

/** Subprotocolo del WebSocket de la interfaz (el núcleo responde este). */
export const WS_PROTOCOL = 'orq';
/** El navegador no puede mandar `Authorization` en el handshake: el token va como `orq.bearer.<token>`. */
export const WS_BEARER_PREFIX = 'orq.bearer.';

/** Token aleatorio por arranque (256 bits, base64url). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Comparación en tiempo constante (se comparan los SHA-256 para no filtrar la longitud). */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Valores de Host aceptados para el servidor en loopback. */
export function loopbackHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

function hostOf(c: Context): string {
  return (c.req.header('host') ?? new URL(c.req.url).host).trim().toLowerCase();
}

/**
 * Defensa contra DNS rebinding: el encabezado Host debe ser exactamente 127.0.0.1:<puerto> o
 * localhost:<puerto>. Un dominio ajeno que resuelva a 127.0.0.1 llega con su propio Host y se rechaza.
 */
export function hostGuard(allowedHosts: () => readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!allowedHosts().includes(hostOf(c))) throw new ApiError(403, 'forbidden_host', 'Host no permitido');
    await next();
  };
}

/**
 * Origen propio del núcleo: `http://<Host>` cuando Host es loopback (`127.0.0.1:<puerto>` o `localhost:<puerto>`,
 * que `hostGuard` ya comprobó). Es el de la interfaz que sirve el propio núcleo.
 */
export function ownOrigin(host: string): string | undefined {
  return /^(127\.0\.0\.1|localhost):\d{1,5}$/.test(host) ? `http://${host}` : undefined;
}

/**
 * Sin CORS: una petición con encabezado Origin (navegador) solo pasa si es el origen propio del núcleo (la interfaz
 * servida en `http://127.0.0.1:<puerto>`) o si está en la lista (vacía por defecto; `ORQ_ALLOWED_ORIGINS`, p. ej.
 * `http://127.0.0.1:5174` para `vite dev`). Postman, Electron (proceso principal) y `ws` de Node no envían Origin.
 */
export function originGuard(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  return async (c, next) => {
    const raw = c.req.header('origin');
    if (raw !== undefined) {
      const origin = raw.trim().toLowerCase();
      if (!allowed.has(origin) && origin !== ownOrigin(hostOf(c))) throw new ApiError(403, 'forbidden_origin', 'Origen no permitido');
    }
    await next();
  };
}

/** Lista de subprotocolos ofrecidos en `Sec-WebSocket-Protocol` (vacía si no hay). */
export function offeredProtocols(header: string | undefined): string[] {
  if (header === undefined) return [];
  return header
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function isWebSocketUpgrade(c: Context): boolean {
  return c.req.header('upgrade')?.toLowerCase() === 'websocket';
}

/**
 * Token del subprotocolo: solo si la lista empieza por `orq` (el servidor responde el primero que se ofrece, y así
 * nunca devuelve el token) y trae exactamente un `orq.bearer.<token>`.
 */
export function protocolToken(header: string | undefined): string | undefined {
  const offered = offeredProtocols(header);
  if (offered[0] !== WS_PROTOCOL) return undefined;
  const bearer = offered.filter((p) => p.startsWith(WS_BEARER_PREFIX));
  if (bearer.length !== 1) return undefined;
  const token = bearer[0]?.slice(WS_BEARER_PREFIX.length) ?? '';
  return /^[A-Za-z0-9._~+/=-]+$/.test(token) ? token : undefined;
}

/**
 * Exige `Authorization: Bearer <token>` en REST y en el handshake del WebSocket. En el handshake, si no hay
 * `Authorization`, acepta el subprotocolo `orq, orq.bearer.<token>` (el `WebSocket` del navegador no manda
 * encabezados). Comparación en tiempo constante; el token nunca aparece en mensajes ni registros.
 */
export function bearerAuth(token: string): MiddlewareHandler {
  if (token.length < 32) throw new Error('Token del servidor demasiado corto');
  return async (c, next) => {
    const header = c.req.header('authorization');
    let presented: string | undefined;
    if (header !== undefined) {
      presented = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]+)[ \t]*$/i.exec(header)?.[1];
    } else if (isWebSocketUpgrade(c)) {
      presented = protocolToken(c.req.header('sec-websocket-protocol'));
    }
    if (!presented || !tokensEqual(presented, token)) {
      c.header('WWW-Authenticate', 'Bearer realm="orquestador"');
      throw new ApiError(401, 'unauthorized', 'Falta el token o no es válido');
    }
    await next();
  };
}

/** CSP de la API (JSON y texto): nada se carga ni se incrusta. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * CSP de la interfaz (HTML): scripts, estilos y fuentes propios (los estilos en línea los usan los componentes),
 * imágenes propias o `data:`/`blob:` (miniaturas de adjuntos) y conexiones solo al mismo origen y a su `/ws`.
 */
export function uiCsp(host: string): string {
  const ws = ownOrigin(host)?.replace(/^http:/, 'ws:');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src 'self'${ws ? ` ${ws}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Encabezados defensivos para todas las respuestas. `Cache-Control` y la CSP, salvo que la ruta fije los suyos. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  // Una ruta que fija su propia CSP (más estricta: adjuntos con `sandbox`, la página del OAuth de Canva) la conserva.
  if (!c.res.headers.has('Content-Security-Policy')) {
    const html = /^text\/html\b/i.test(c.res.headers.get('Content-Type') ?? '');
    c.header('Content-Security-Policy', html ? uiCsp(hostOf(c)) : API_CSP);
  }
};
