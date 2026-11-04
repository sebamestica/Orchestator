import { describe, expect, it } from 'vitest';
import { probeCore, runningTasks, type FetchLike } from '../../apps/desktop/src/lib/core-client.ts';

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
  it('cuenta las tareas en curso con el token solo en el encabezado', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { tasks: [{ task: { id: 'a' } }, { task: { id: 'b' } }] } }));
    expect(await runningTasks(ORIGIN, TOKEN, f)).toEqual({ status: 'ok', running: 2 });
    expect(f.calls[0]?.url).toBe(`${ORIGIN}/tasks?state=running`);
    expect(f.calls[0]?.url).not.toContain(TOKEN);
    expect(f.calls[0]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
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
