import type { DesktopBridge } from '../../shared/api.ts';

declare global {
  interface Window {
    orq?: DesktopBridge;
  }
}

export interface CoreEndpoint {
  /** Base de la API ('' = mismo origen; '/__core' en `vite dev`). */
  url: string;
  wsUrl: string;
  token: string;
}

/** Puente de Electron (`window.orq`); en la web no existe. */
export const desktop: DesktopBridge | undefined = typeof window === 'undefined' ? undefined : window.orq;
export const isDesktop = desktop !== undefined;

const TOKEN_KEY = 'orq.token';

function readSessionToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeSessionToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Sin sessionStorage (modo privado): el token vive solo en memoria.
  }
}

/**
 * En la web el núcleo abre `http://127.0.0.1:47811/#t=<token>`: el token se toma del fragmento, se borra
 * de la barra de direcciones y queda solo en sessionStorage de esa pestaña (nunca en localStorage).
 */
export function takeTokenFromLocation(loc: Location = window.location, hist: History = window.history): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{32,})/.exec(loc.hash);
  if (!m?.[1]) return readSessionToken();
  writeSessionToken(m[1]);
  // `#t=…` o `#/ruta&t=…`: se quita solo el token y se conserva la ruta (sin duplicar el `#`).
  const rest = loc.hash.slice(1).replace(/(?:^|&)t=[A-Za-z0-9_-]+/, '').replace(/^&/, '');
  hist.replaceState(null, '', `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}`);
  return m[1];
}

export async function resolveCore(): Promise<CoreEndpoint | null> {
  if (desktop) return desktop.core();
  const token = takeTokenFromLocation();
  if (!token) return null;
  const dev = import.meta.env.DEV;
  const origin = window.location.origin;
  return {
    url: dev ? '/__core' : '',
    wsUrl: `${origin.replace(/^http/, 'ws')}${dev ? '/__core' : ''}/ws`,
    token,
  };
}
