import { posix, win32 } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

function getVar(env: Env, name: string): string | undefined {
  // En Windows las variables no distinguen mayúsculas («Path» suele venir así).
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export interface FindOptions {
  env: Env;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
}

/**
 * Busca un ejecutable en el PATH. Solo carpetas absolutas: una entrada relativa («.») permitiría que un
 * `node.exe` plantado en la carpeta de trabajo se ejecutara en lugar del de verdad.
 */
export function findOnPath(name: string, opts: FindOptions): string | null {
  const p = opts.platform === 'win32' ? win32 : posix;
  const sep = opts.platform === 'win32' ? ';' : ':';
  for (const raw of (getVar(opts.env, 'PATH') ?? '').split(sep)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir)) continue;
    const candidate = p.join(dir, name);
    if (opts.exists(candidate)) return candidate;
  }
  return null;
}

/** `node.exe` de Windows para el núcleo: `ORQ_NODE` (ruta absoluta) o el primero del PATH. */
export function resolveNodePath(opts: FindOptions): string | null {
  const override = getVar(opts.env, 'ORQ_NODE')?.trim();
  const p = opts.platform === 'win32' ? win32 : posix;
  if (override) return p.isAbsolute(override) && opts.exists(override) ? override : null;
  return findOnPath(opts.platform === 'win32' ? 'node.exe' : 'node', opts);
}

/** Variables propias de la app que el núcleo no necesita (y el token, que nunca baja al hijo). */
const DESKTOP_ONLY = new Set(['ORQ_UI_DEV', 'ORQ_DEVTOOLS', 'ORQ_CORE_TOKEN', 'ORQ_NODE', 'ORQ_REPO_ROOT', 'ORQ_CORE_TIMEOUT_MS']);

/**
 * Entorno del núcleo hijo: el del usuario sin las variables de Electron (`ELECTRON_RUN_AS_NODE` y
 * compañía) ni las de la app, con `ORQ_PORT` fijo y los orígenes de la interfaz añadidos a
 * `ORQ_ALLOWED_ORIGINS` (sin ellos el núcleo rechaza los POST y el `/ws` de la ventana).
 */
export function childEnv(env: Env, opts: { port: number; allowedOrigins: readonly string[] }): Record<string, string> {
  const out: Record<string, string> = {};
  let origins: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith('ELECTRON_') || DESKTOP_ONLY.has(upper) || upper === 'ORQ_PORT') continue;
    if (upper === 'ORQ_ALLOWED_ORIGINS') {
      origins = value.split(',').map((o) => o.trim()).filter(Boolean);
      continue;
    }
    out[key] = value;
  }
  for (const o of opts.allowedOrigins) if (!origins.includes(o)) origins.push(o);
  out.ORQ_PORT = String(opts.port);
  if (origins.length > 0) out.ORQ_ALLOWED_ORIGINS = origins.join(',');
  return out;
}
