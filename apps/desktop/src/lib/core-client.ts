import { z } from 'zod';

/** Subconjunto de `fetch` que usa la app (inyectable en pruebas). */
export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type ProbeResult = 'alive' | 'down' | 'foreign' | 'timeout';

const healthOk = z.object({ ok: z.literal(true), version: z.string(), startedAt: z.string() });
const unauthorized = z.object({ error: z.object({ code: z.literal('unauthorized') }) });
const tasksBody = z.object({ tasks: z.array(z.object({ state: z.string() }).loose()) });
const chatsBody = z.object({ chats: z.array(z.object({ state: z.string(), backgroundTasks: z.number().optional() }).loose()) });
/** Estados de tarea con trabajo pendiente o en curso: apagar el núcleo los cortaría. */
const ACTIVE_TASK_STATES: ReadonlySet<string> = new Set(['ready', 'running', 'review', 'handed_off']);

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
 * Trabajo en curso en el núcleo: tareas de la flota activas (`ready`, `running`, `review`, `handed_off`, de
 * `GET /tasks`) más los chats de la mente que están respondiendo o tienen subagentes trabajando en segundo plano
 * (`GET /chats`). Sirve también para validar un token: 401 = no es de este núcleo. El token va solo en el encabezado
 * `Authorization`. Si no se puede saber, `error` (y el núcleo no se apaga). `cancel` corta las dos peticiones (cierre
 * de la ventana con plazo vencido).
 */
export async function runningTasks(origin: string, token: string, fetchImpl: FetchLike, timeoutMs = 3000, cancel?: AbortSignal): Promise<RunningCheck> {
  const signal = () => (cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs));
  const get = (path: string) => fetchImpl(`${origin}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: signal() });
  try {
    const res = await get('/tasks');
    if (res.status === 401) return { status: 'unauthorized' };
    if (res.status !== 200) return { status: 'error' };
    const tasks = tasksBody.safeParse(await readJson(res));
    if (!tasks.success) return { status: 'error' };
    const chatsRes = await get('/chats');
    if (chatsRes.status !== 200) return { status: 'error' };
    const chats = chatsBody.safeParse(await readJson(chatsRes));
    if (!chats.success) return { status: 'error' };
    const busyTasks = tasks.data.tasks.filter((t) => ACTIVE_TASK_STATES.has(t.state)).length;
    const busyChats = chats.data.chats.filter((c) => c.state === 'running' || (c.backgroundTasks ?? 0) > 0).length;
    return { status: 'ok', running: busyTasks + busyChats };
  } catch {
    return { status: 'error' };
  }
}
