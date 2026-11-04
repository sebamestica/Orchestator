/**
 * Interfaz estática (`dist/ui`) servida por el núcleo SIN token: solo `GET`/`HEAD` de `/`, `/index.html` y
 * `/assets/*`. Va antes de `bearerAuth` (después de Host y Origin); todo lo demás sigue exigiendo el token. No lista
 * carpetas, no sigue `..` ni separadores codificados y no sirve archivos ocultos.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

export const UI_INDEX = 'index.html';
export const UI_ASSETS_PREFIX = '/assets/';
/** Los archivos de `/assets` llevan el hash en el nombre (Vite): se pueden guardar para siempre. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

export function mimeType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export const UI_MISSING_TEXT =
  'La interfaz no está compilada (falta dist/ui/index.html). Ejecuta «npm run build:ui» en el repositorio del orquestador y recarga.';

export interface StaticUiOptions {
  /** Carpeta de la interfaz compilada (`dist/ui`). Puede no existir: entonces `/` responde 404 con un texto claro. */
  dir: string;
}

function text(status: 400 | 404, body: string, head: boolean): Response {
  return new Response(head ? null : body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/**
 * Segmentos de `/assets/<…>` ya decodificados, o `undefined` si la ruta no es segura: `..` o `.`, separadores o
 * dos puntos codificados (`%2F`, `%5C`, `:`), NUL, segmentos vacíos u ocultos (`.algo`).
 */
export function safeAssetSegments(rawPath: string): string[] | undefined {
  const rest = rawPath.slice(UI_ASSETS_PREFIX.length);
  if (rest === '') return undefined;
  const out: string[] = [];
  for (const raw of rest.split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (seg === '' || seg.startsWith('.') || /[\\/:\0]/.test(seg)) return undefined;
    out.push(seg);
  }
  return out;
}

/** `file` (ya resuelto, con enlaces) está dentro de `root` (también resuelto). */
function inside(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`) && !/^[A-Za-z]:/.test(rel);
}

async function fileResponse(file: string, cacheControl: string, head: boolean, root?: string): Promise<Response | undefined> {
  let size: number;
  try {
    // Un enlace simbólico o una unión dentro de la carpeta no puede sacar un archivo de fuera.
    if (root !== undefined && !inside(await realpath(file), await realpath(root))) return undefined;
    const st = await stat(file);
    if (!st.isFile()) return undefined;
    size = st.size;
  } catch {
    return undefined;
  }
  const headers = { 'Content-Type': mimeType(file), 'Content-Length': String(size), 'Cache-Control': cacheControl };
  if (head) return new Response(null, { status: 200, headers });
  try {
    return new Response(await readFile(file), { status: 200, headers });
  } catch {
    return undefined;
  }
}

/** Middleware de la interfaz estática. Lo que no es `/`, `/index.html` ni `/assets/*` sigue de largo (al token). */
export function staticUi(opts: StaticUiOptions): MiddlewareHandler {
  const root = resolve(opts.dir);
  const assetsRoot = join(root, 'assets');
  return async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return next();
    const head = method === 'HEAD';
    // La ruta cruda (sin decodificar): `%2F` y `%5C` no deben convertirse en separadores antes de comprobarla.
    const path = new URL(c.req.url).pathname;
    if (path === '/' || path === `/${UI_INDEX}`) {
      return (await fileResponse(join(root, UI_INDEX), 'no-store', head)) ?? text(404, UI_MISSING_TEXT, head);
    }
    if (!path.startsWith(UI_ASSETS_PREFIX)) return next();
    const segments = safeAssetSegments(path);
    if (!segments) return text(400, 'Ruta de recurso no válida', head);
    const file = join(assetsRoot, ...segments);
    if (!inside(file, assetsRoot)) return text(400, 'Ruta de recurso no válida', head);
    return (await fileResponse(file, IMMUTABLE_CACHE, head, assetsRoot)) ?? text(404, 'No existe el recurso', head);
  };
}
