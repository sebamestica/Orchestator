/** Utilidades HTTP comunes: `fetch` inyectable, captura de cabeceras y lectura de JSON validable. */

export type FetchFn = typeof globalThis.fetch;

/** Error de una respuesta HTTP no exitosa en las llamadas propias (listado de modelos, `/key`). */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;

  constructor(status: number, body: string, headers: Headers, url: string) {
    super(`HTTP ${status} en ${safeUrl(url)}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** URL sin query (Google acepta `?key=`; nunca la usamos, pero no se arriesga a registrarla). */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/**
 * Envuelve `fetch` para entregar las cabeceras de cada respuesta (incluidos los reintentos de los SDK)
 * antes de que se consuma el cuerpo. Así el cupo por cabeceras funciona igual con los cinco proveedores.
 */
export function trackingFetch(base: FetchFn, onResponse: (headers: Headers, url: string) => void): FetchFn {
  const wrapped = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]): Promise<Response> => {
    const res = await base(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    try {
      onResponse(res.headers, url);
    } catch {
      /* un fallo del observador no debe romper la llamada */
    }
    return res;
  };
  return wrapped as FetchFn;
}

/** GET que devuelve el JSON (sin validar: lo valida quien llama con Zod) o lanza `HttpError`. */
export async function getJson(
  doFetch: FetchFn,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, res.headers, url);
  }
  return res.json();
}
