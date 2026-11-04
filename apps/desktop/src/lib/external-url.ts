/** Tope de longitud de una URL externa (una URL legítima no pasa de unos cientos de caracteres). */
export const MAX_EXTERNAL_URL = 4096;

/**
 * URL que la app puede abrir en el navegador del sistema (`shell.openExternal`): solo `https:` y
 * `http://127.0.0.1` (servicios locales). Nada de `file:`, `javascript:`, `data:`, esquemas de Windows
 * (`ms-settings:`, `search-ms:`…) ni credenciales en la URL. Devuelve la URL normalizada o `null`.
 */
export function allowedExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_EXTERNAL_URL) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url.hostname ? url.href : null;
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url.href;
  return null;
}

/** ¿`raw` es del mismo origen que la app? (`http://127.0.0.1:47811` o el de Vite en desarrollo). */
export function isSameOrigin(raw: unknown, appOrigin: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  try {
    return new URL(raw).origin === appOrigin;
  } catch {
    return false;
  }
}

export type NavigationVerdict = 'allow' | 'external' | 'block';

/**
 * La ventana solo navega dentro de su origen. Un enlace permitido fuera de él se abre en el navegador;
 * todo lo demás (archivos soltados `file:`, `data:`, otros esquemas) se bloquea.
 */
export function classifyNavigation(raw: string, appOrigin: string): NavigationVerdict {
  if (isSameOrigin(raw, appOrigin)) return 'allow';
  return allowedExternalUrl(raw) ? 'external' : 'block';
}
