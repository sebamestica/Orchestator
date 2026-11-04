import type { CoreEndpoint } from './bridge.ts';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

let endpoint: CoreEndpoint | null = null;

export function setCoreEndpoint(core: CoreEndpoint | null): void {
  endpoint = core;
}

export function coreEndpoint(): CoreEndpoint {
  if (!endpoint) throw new ApiError(0, 'no_core', 'Sin conexión con el núcleo');
  return endpoint;
}

async function request<T>(method: Method, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const core = coreEndpoint();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${core.token}`);
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body;
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${core.url}${path}`, { ...init, method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/** Cliente REST del núcleo. Los tipos de respuesta están en `./types.ts`. */
export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('POST', path, body ?? {}, init),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** Sube bytes crudos (adjuntos): `POST <path>?name=…` con el `Content-Type` del archivo. */
  upload: <T>(path: string, file: Blob, name: string) =>
    request<T>('POST', `${path}${path.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}`, file, {
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    }),
};
