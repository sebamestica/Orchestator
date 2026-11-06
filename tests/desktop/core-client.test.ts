import { describe, expect, it } from 'vitest';
import { acceptsOrigin, probeCore, runningTasks, type FetchLike } from '../../apps/desktop/src/lib/core-client.ts';

const ORIGIN = 'http://127.0.0.1:47899';
const TOKEN = 'x'.repeat(43);

type Call = { url: string; headers: Record<string, string> | undefined };

function fakeFetch(respond: (url: string, headers: Record<string, string> | undefined) => { status: number; body?: unknown } | Error): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = async (url: string, init: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const r = respond(url, init.headers);
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError('Unexpected end of JSON input');
        return r.body;
      },
    };
  };
  return Object.assign(f, { calls });
}

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('probeCore', () => {
  it('un /health público o uno que pide token son un núcleo vivo', async () => {
    const pub = fakeFetch(() => ({ status: 200, body: { ok: true, version: '0.1.0', startedAt: '2026-11-04T10:00:00.000Z', uptimeMs: 5 } }));
    expect(await probeCore(ORIGIN, pub)).toBe('alive');
    expect(pub.calls[0]).toEqual({ url: `${ORIGIN}/health`, headers: undefined });
    const auth = fakeFetch(() => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Falta el token o no es válido' } } }));
    expect(await probeCore(ORIGIN, auth)).toBe('alive');
  });

  it('otro programa en el puerto no es un núcleo', async () => {
    expect(await probeCore(ORIGIN, fakeFetch(() => ({ status: 404, body: { error: 'nope' } })))).toBe('foreign');
    expect(await probeCore(ORIGIN, fakeFetch(() => ({ status: 200 })))).toBe('foreign');
    expect(await probeCore(ORIGIN, fakeFetch(() => ({ status: 401, body: { error: { code: 'otro' } } })))).toBe('foreign');
  });

  it('distingue puerto cerrado de núcleo que no contesta a tiempo', async () => {
    expect(await probeCore(ORIGIN, fakeFetch(refused))).toBe('down');
    expect(await probeCore(ORIGIN, fakeFetch(timeout))).toBe('timeout');
  });
});

describe('runningTasks', () => {
  it('cuenta las tareas activas (lista, en curso, en revisión, en traspaso) con el token solo en el encabezado', async () => {
    const tasks = ['running', 'review', 'handed_off', 'ready', 'integrated', 'failed', 'pending'].map((state, i) => ({ task: { id: `t${i}` }, state }));
    const f = fakeFetch((url) => ({ status: 200, body: url.endsWith('/chats') ? { chats: [] } : { tasks } }));
    expect(await runningTasks(ORIGIN, TOKEN, f)).toEqual({ status: 'ok', running: 4 });
    expect(f.calls.map((c) => c.url)).toEqual([`${ORIGIN}/tasks`, `${ORIGIN}/chats`]);
    for (const c of f.calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    }
  });

  it('cuenta también la mente: un chat respondiendo o con subagentes en segundo plano mantiene vivo el núcleo', async () => {
    const chats = [{ state: 'running' }, { state: 'idle', backgroundTasks: 3 }, { state: 'idle' }, { state: 'idle', backgroundTasks: 0 }];
    const f = fakeFetch((url) => ({ status: 200, body: url.endsWith('/chats') ? { chats } : { tasks: [] } }));
    expect(await runningTasks(ORIGIN, TOKEN, f)).toEqual({ status: 'ok', running: 2 });
    // Sin poder leer los chats no se sabe: error (y el núcleo no se apaga).
    const noChats = fakeFetch((url) => (url.endsWith('/chats') ? { status: 500, body: {} } : { status: 200, body: { tasks: [] } }));
    expect(await runningTasks(ORIGIN, TOKEN, noChats)).toEqual({ status: 'error' });
  });

  it('401 significa que el token no es de este núcleo', async () => {
    expect(await runningTasks(ORIGIN, TOKEN, fakeFetch(() => ({ status: 401, body: { error: { code: 'unauthorized' } } })))).toEqual({ status: 'unauthorized' });
  });

  it('errores, respuestas raras y caídas dan error (y entonces no se apaga nada)', async () => {
    expect(await runningTasks(ORIGIN, TOKEN, fakeFetch(() => ({ status: 500, body: {} })))).toEqual({ status: 'error' });
    expect(await runningTasks(ORIGIN, TOKEN, fakeFetch(() => ({ status: 200, body: { tasks: 'no' } })))).toEqual({ status: 'error' });
    expect(await runningTasks(ORIGIN, TOKEN, fakeFetch(() => ({ status: 200 })))).toEqual({ status: 'error' });
    expect(await runningTasks(ORIGIN, TOKEN, fakeFetch(refused))).toEqual({ status: 'error' });
    expect(await runningTasks(ORIGIN, TOKEN, fakeFetch(timeout))).toEqual({ status: 'error' });
  });
});

describe('acceptsOrigin', () => {
  const DEV = 'http://127.0.0.1:5174';

  it('manda el Origin de la ventana a /health y distingue la guardia de origen del token', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: { code: 'unauthorized' } } }));
    expect(await acceptsOrigin(ORIGIN, DEV, f)).toBe('yes');
    expect(f.calls).toEqual([{ url: `${ORIGIN}/health`, headers: { Origin: DEV } }]);
    expect(await acceptsOrigin(ORIGIN, DEV, fakeFetch(() => ({ status: 403, body: { error: { code: 'forbidden_origin' } } })))).toBe('no');
  });

  it('sin respuesta o con otra cosa no se sabe', async () => {
    expect(await acceptsOrigin(ORIGIN, DEV, fakeFetch(refused))).toBe('error');
    expect(await acceptsOrigin(ORIGIN, DEV, fakeFetch(() => ({ status: 403, body: {} })))).toBe('error');
  });
});
