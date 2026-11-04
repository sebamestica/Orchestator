import type { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { redactSecrets } from '../../../../src/shared/redact.ts';

/** Lo que anuncia `iniciar` en su línea `{"ready":true,"url","wsUrl","token"}` de stdout, ya validado. */
export interface CoreReady {
  /** `http://127.0.0.1:<puerto>` (sin barra final). */
  origin: string;
  wsUrl: string;
  token: string;
  port: number;
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32,512}$/;
/** El núcleo puede añadir campos (p. ej. el enlace de la web): solo se exigen estos. */
const readyLineSchema = z.object({
  ready: z.literal(true),
  url: z.string().max(200),
  wsUrl: z.string().max(200),
  token: z.string().regex(TOKEN_RE),
});

export type ReadyParse = { kind: 'ready'; ready: CoreReady } | { kind: 'invalid'; reason: string } | { kind: 'other' };

function loopbackPort(raw: string, protocol: 'http:' | 'ws:', path: string): number | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== protocol || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== path && !(path === '/' && u.pathname === '')) return null;
  const port = Number(u.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Interpreta una línea de stdout. Las líneas que no son la de `ready` son ruido (`other`). Una línea
 * `ready` mal formada o que apunta fuera de 127.0.0.1 es `invalid`: el token nunca se manda a otro sitio.
 * El motivo nunca incluye el contenido de la línea (lleva el token).
 */
export function parseReadyLine(line: string): ReadyParse {
  const text = line.trim();
  if (!text.startsWith('{') || !text.includes('"ready"')) return { kind: 'other' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'other' };
  }
  if (typeof data !== 'object' || data === null || (data as { ready?: unknown }).ready !== true) return { kind: 'other' };
  const parsed = readyLineSchema.safeParse(data);
  if (!parsed.success) return { kind: 'invalid', reason: 'la línea ready no tiene url, wsUrl y token válidos' };
  const port = loopbackPort(parsed.data.url, 'http:', '/');
  const wsPort = loopbackPort(parsed.data.wsUrl, 'ws:', '/ws');
  if (port === null || wsPort === null) return { kind: 'invalid', reason: 'la línea ready no apunta a 127.0.0.1' };
  if (port !== wsPort) return { kind: 'invalid', reason: 'url y wsUrl de la línea ready usan puertos distintos' };
  return {
    kind: 'ready',
    ready: { origin: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token: parsed.data.token, port },
  };
}

export type CoreStartReason = 'timeout' | 'exit' | 'spawn' | 'invalid' | 'port';

export class CoreStartError extends Error {
  override readonly name = 'CoreStartError';
  readonly reason: CoreStartReason;
  readonly exitCode: number | null;
  constructor(reason: CoreStartReason, message: string, exitCode: number | null = null) {
    super(message);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

type Readable = Pick<EventEmitter, 'on' | 'off'>;

export interface ReadySource {
  stdout: Readable;
  /** El proceso hijo: `exit` (código) y `error` (no se pudo lanzar). */
  child: Readable;
  /** Opcional: stderr por tubería. Nunca se busca ahí la línea `ready`; solo se guarda su cola para el error. */
  stderr?: Readable;
}

export interface WaitReadyOptions {
  timeoutMs: number;
  /** Si se indica, una línea `ready` con otro puerto es un error. */
  expectedPort?: number;
  /** Tope de una línea sin salto (más es ruido y se descarta hasta el siguiente salto). */
  maxLineBytes?: number;
  /** Líneas de stderr que se conservan para el mensaje de error. */
  stderrTailLines?: number;
  /** Margen tras cerrarse stdout para recibir `exit` y dar el código de salida en el error. */
  endGraceMs?: number;
}

/** Últimas líneas de un texto, tachadas (para mensajes de error y la cola del registro). */
export function tailLines(text: string, maxLines: number, secrets: readonly string[] = []): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return redactSecrets(lines.slice(-maxLines).join('\n'), secrets).slice(-4000);
}

/**
 * Espera la línea `ready` en stdout del núcleo. Soporta trozos partidos (también a mitad de un carácter
 * UTF-8), CRLF y ruido antes de la línea; falla si el proceso no arranca, termina antes o vence el plazo.
 * Al resolverse quita sus escuchas: quien llama sigue drenando stdout para que la tubería no se llene.
 */
export function waitForReady(src: ReadySource, opts: WaitReadyOptions): Promise<CoreReady> {
  const maxLine = opts.maxLineBytes ?? 64 * 1024;
  const tailMax = opts.stderrTailLines ?? 20;
  return new Promise<CoreReady>((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let buffer = '';
    let skipping = false;
    let stderrText = '';
    let settled = false;
    let endTimer: NodeJS.Timeout | undefined;

    const tail = () => {
      const t = tailLines(stderrText, tailMax);
      return t ? `\n${t}` : '';
    };
    const finish = (err: CoreStartError | null, ready?: CoreReady) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(endTimer);
      src.stdout.off('data', onData);
      src.stdout.off('end', onEnd);
      src.child.off('exit', onExit);
      src.child.off('error', onError);
      src.stderr?.off('data', onStderr);
      if (err) reject(err);
      else if (ready) resolve(ready);
    };
    const onLine = (line: string) => {
      const r = parseReadyLine(line);
      if (r.kind === 'other') return;
      if (r.kind === 'invalid') return finish(new CoreStartError('invalid', `El núcleo arrancó con una línea ready inválida: ${r.reason}`));
      if (opts.expectedPort !== undefined && r.ready.port !== opts.expectedPort) {
        return finish(new CoreStartError('port', `El núcleo escucha en el puerto ${r.ready.port} y se esperaba el ${opts.expectedPort}`));
      }
      finish(null, r.ready);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let nl = buffer.indexOf('\n');
      while (nl !== -1 && !settled) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (skipping) skipping = false;
        else onLine(line.replace(/\r$/, ''));
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > maxLine) {
        buffer = '';
        skipping = true;
      }
    };
    const onEnd = () => {
      if (!skipping && buffer) onLine(buffer + decoder.end());
      if (settled) return;
      // stdout suele cerrarse un instante antes de `exit`: se espera un poco para dar el código.
      endTimer = setTimeout(() => {
        finish(new CoreStartError('exit', `El núcleo cerró su salida antes de anunciar que estaba listo${tail()}`));
      }, opts.endGraceMs ?? 1000);
    };
    const onExit = (code: number | null) => {
      finish(new CoreStartError('exit', `El núcleo terminó (código ${code ?? '?'}) antes de anunciar que estaba listo${tail()}`, code));
    };
    const onError = (err: Error) => {
      finish(new CoreStartError('spawn', `No se pudo lanzar el núcleo: ${redactSecrets(err.message)}`));
    };
    const onStderr = (chunk: Buffer | string) => {
      stderrText = (stderrText + (typeof chunk === 'string' ? chunk : errDecoder.write(chunk))).slice(-16 * 1024);
    };
    const timer = setTimeout(() => {
      finish(new CoreStartError('timeout', `El núcleo no anunció que estaba listo en ${Math.round(opts.timeoutMs / 1000)} s${tail()}`));
    }, opts.timeoutMs);

    src.stdout.on('data', onData);
    src.stdout.on('end', onEnd);
    src.child.on('exit', onExit);
    src.child.on('error', onError);
    src.stderr?.on('data', onStderr);
  });
}
