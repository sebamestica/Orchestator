import { z } from 'zod';

/** Subconjunto de `fetch` que usa la app (inyectable en pruebas). */
export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type ProbeResult = 'alive' | 'down' | 'foreign' | 'timeout';

const healthOk = z.object({ ok: z.literal(true), version: z.string(), startedAt: z.string() });
const unauthorized = z.object({ error: z.object({ code: z.literal('unauthorized') }) });
const tasksBody = z.object({ tasks: z.array(z.unknown()) });

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * ¿Hay un núcleo en `origin`? `GET /health` responde 200 (si es público) o 401 con `unauthorized`
 * (si exige token, como hoy): los dos casos son un núcleo vivo. Otra respuesta es otro programa en el puerto.
 */
export async function probeCore(origin: string, fetchImpl: FetchLike, timeoutMs = 2000): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${origin}/health`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    const body = await readJson(res);
    if (res.status === 200 && healthOk.safeParse(body).success) return 'alive';
    if (res.status === 401 && unauthorized.safeParse(body).success) return 'alive';
    return 'foreign';
  } catch (err) {
    return isTimeout(err) ? 'timeout' : 'down';
  }
}

export type RunningCheck = { status: 'ok'; running: number } | { status: 'unauthorized' } | { status: 'error' };

/**
 * Tareas en curso (`GET /tasks?state=running`). Sirve también para validar un token: 401 = no es de
 * este núcleo. El token va solo en el encabezado `Authorization`.
 */
export async function runningTasks(origin: string, token: string, fetchImpl: FetchLike, timeoutMs = 3000): Promise<RunningCheck> {
  try {
    const res = await fetchImpl(`${origin}/tasks?state=running`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { status: 'unauthorized' };
    if (res.status !== 200) return { status: 'error' };
    const body = tasksBody.safeParse(await readJson(res));
    return body.success ? { status: 'ok', running: body.data.tasks.length } : { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}
