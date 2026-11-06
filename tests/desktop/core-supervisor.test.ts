import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreSupervisor, type SpawnFn } from '../../apps/desktop/src/core-supervisor.ts';
import { loadDesktopConfig, type DesktopConfig } from '../../apps/desktop/src/lib/config.ts';
import type { FetchLike } from '../../apps/desktop/src/lib/core-client.ts';
import { decodeSession, encodeSession, type Cipher } from '../../apps/desktop/src/lib/session-file.ts';

const FAKE_CORE = fileURLToPath(new URL('./fake-core.ts', import.meta.url));
const PORT = 47899;
const TOKEN = 'T0k3n_de_prueba-'.repeat(3);

const cipher: Cipher = {
  encrypt: (s) => Buffer.from(`v10${Buffer.from(s).reverse().toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(3), 'base64').reverse().toString(),
};

let dir: string;
let config: DesktopConfig;
const children: ChildProcess[] = [];
const killed: number[] = [];
const logs: string[] = [];

/** Lanza el núcleo falso con las mismas opciones que recibiría `node.exe cli.ts iniciar`. */
function fakeSpawn(mode: 'ready' | 'fail', seen: { command?: string; args?: readonly string[]; opts?: Parameters<SpawnFn>[2] }): SpawnFn {
  return (command, args, opts) => {
    seen.command = command;
    seen.args = args;
    seen.opts = opts;
    const env = { ...opts.env, FAKE_CORE_MODE: mode, FAKE_CORE_TOKEN: TOKEN };
    const child = spawn(process.execPath, [FAKE_CORE], { ...opts, env });
    children.push(child);
    return child;
  };
}

const killTree = async (pid: number) => {
  killed.push(pid);
  try {
    process.kill(pid);
  } catch {
    // Ya terminó.
  }
};

/** Espera `ms` como un `fetch` lento; si `signal` aborta antes, rechaza como `fetch`. */
function slow(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

/** `fetch` falso: núcleo caído hasta que «arranca»; luego /tasks con el token correcto (con `delayMs`, lento). */
function fakeFetch(state: { up: boolean; running: number; token?: string; delayMs?: number; allowedOrigins?: string[] }): FetchLike {
  return async (url, init) => {
    if (!state.up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (state.delayMs) await slow(state.delayMs, init.signal);
    // Guardia de origen del núcleo (antes que la del token): solo el propio origen o ORQ_ALLOWED_ORIGINS.
    const requestOrigin = init.headers?.Origin;
    if (requestOrigin !== undefined && requestOrigin !== `http://127.0.0.1:${PORT}` && !(state.allowedOrigins ?? []).includes(requestOrigin)) {
      return { status: 403, json: async () => ({ error: { code: 'forbidden_origin' } }) };
    }
    const auth = init.headers?.Authorization;
    if (url.endsWith('/health')) return { status: 401, json: async () => ({ error: { code: 'unauthorized', message: 'x' } }) };
    if (url.endsWith('/tasks') || url.endsWith('/chats')) {
      if (auth !== `Bearer ${state.token ?? TOKEN}`) return { status: 401, json: async () => ({ error: { code: 'unauthorized' } }) };
      if (url.endsWith('/chats')) return { status: 200, json: async () => ({ chats: [] }) };
      return { status: 200, json: async () => ({ tasks: Array.from({ length: state.running }, (_, i) => ({ task: { id: `t${i}` }, state: 'running' })) }) };
    }
    return { status: 404, json: async () => ({}) };
  };
}

function supervisor(over: Partial<ConstructorParameters<typeof CoreSupervisor>[0]> = {}) {
  return new CoreSupervisor({
    config,
    env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ORQ_ALLOWED_ORIGINS: 'http://127.0.0.1:9000' },
    platform: process.platform,
    cipher,
    fetch: fakeFetch({ up: false, running: 0 }),
    nodePath: process.execPath,
    log: (l) => logs.push(l),
    killTree,
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orq-desktop-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src', 'core', 'app'), { recursive: true });
  writeFileSync(join(repo, 'src', 'core', 'app', 'cli.ts'), '// núcleo de mentira\n');
  config = loadDesktopConfig({
    env: { ORQ_PORT: String(PORT), ORQ_DATA_DIR: join(dir, 'datos'), ORQ_REPO_ROOT: repo, ORQ_CORE_TIMEOUT_MS: '20000' },
    platform: process.platform,
    appPath: join(repo, 'apps', 'desktop', 'out'),
  });
  logs.length = 0;
  killed.length = 0;
});

afterEach(async () => {
  // El núcleo falso tiene su cwd dentro de la carpeta temporal: hay que esperar a que salga para borrarla.
  await Promise.all(
    children.splice(0).map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) return resolve();
          const t = setTimeout(resolve, 5000);
          c.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
          try {
            process.kill(c.pid ?? 0);
          } catch {
            // Ya lo mató la prueba: se espera su `exit`.
          }
        }),
    ),
  );
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('CoreSupervisor', () => {
  it('sin núcleo vivo lanza uno (sin shell, oculto, desacoplado), lee su línea ready y guarda la sesión cifrada', async () => {
    const seen: { command?: string; args?: readonly string[]; opts?: Parameters<SpawnFn>[2] } = {};
    const sup = supervisor({ spawn: fakeSpawn('ready', seen) });
    const r = await sup.connect();
    expect(r).toMatchObject({ ok: true, core: { origin: `http://127.0.0.1:${PORT}`, wsUrl: `ws://127.0.0.1:${PORT}/ws`, token: TOKEN, ownership: 'launched' } });
    expect(seen.command).toBe(process.execPath);
    expect(seen.args).toEqual([join(config.repoRoot, 'src', 'core', 'app', 'cli.ts'), 'iniciar']);
    expect(seen.opts).toMatchObject({ cwd: config.repoRoot, shell: false, windowsHide: true, detached: true });
    expect(seen.opts?.stdio?.[1]).toBe('pipe');
    expect(typeof seen.opts?.stdio?.[2]).toBe('number');

    const session = readFileSync(config.sessionPath, 'utf8');
    expect(session).not.toContain(TOKEN);
    expect(JSON.parse(session)).toMatchObject({ port: PORT, launchedBy: 'desktop' });

    // stderr del núcleo va al archivo de registro (no a una tubería), con el entorno ya limpio.
    await new Promise((res) => setTimeout(res, 400));
    const log = readFileSync(sup.logPath, 'utf8');
    expect(log).toContain('aviso de arranque en stderr');
    expect(log).toContain(`ORQ_PORT=${PORT} ORQ_ALLOWED_ORIGINS=http://127.0.0.1:9000,http://127.0.0.1:${PORT} ELECTRON_RUN_AS_NODE=- ORQ_CORE_TOKEN=-`);
    expect(log).not.toContain(TOKEN);
  });

  it('al cerrar sin tareas en curso apaga su núcleo por PID y borra la sesión', async () => {
    const net = { up: false, running: 0 };
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), fetch: fakeFetch(net) });
    const r = await sup.connect();
    if (!r.ok) throw new Error(r.title);
    net.up = true;
    const d = await sup.onAppClose();
    expect(d.stop).toBe(true);
    expect(killed).toEqual([r.core.pid]);
    expect(existsSync(config.sessionPath)).toBe(false);
  });

  it('al cerrar con tareas en curso deja el núcleo vivo y la sesión para la próxima apertura', async () => {
    const net = { up: false, running: 0 };
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), fetch: fakeFetch(net) });
    expect((await sup.connect()).ok).toBe(true);
    Object.assign(net, { up: true, running: 2 });
    const d = await sup.onAppClose();
    expect(d).toEqual({ stop: false, reason: '2 trabajos en curso (tareas o la mente): el núcleo sigue vivo' });
    expect(killed).toEqual([]);
    expect(existsSync(config.sessionPath)).toBe(true);
  });

  it('si el plazo del cierre vence antes de apagar, no mata nada y la sesión queda', async () => {
    const net = { up: false, running: 0, delayMs: 0 };
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), fetch: fakeFetch(net) });
    expect((await sup.connect()).ok).toBe(true);
    Object.assign(net, { up: true, delayMs: 300 });
    const d = await sup.onAppClose(AbortSignal.timeout(100));
    expect(d).toEqual({ stop: false, reason: 'el cierre tardó demasiado: el núcleo sigue vivo' });
    expect(killed).toEqual([]);
    expect(existsSync(config.sessionPath)).toBe(true);
  });

  it('si el plazo vence con el apagado ya empezado, espera a que termine y borra la sesión', async () => {
    const net = { up: false, running: 0, delayMs: 0 };
    const deadline = new AbortController();
    let killDone = false;
    const slowKill = async (pid: number) => {
      deadline.abort();
      await new Promise((r) => setTimeout(r, 300));
      await killTree(pid);
      killDone = true;
    };
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), fetch: fakeFetch(net), killTree: slowKill });
    const r = await sup.connect();
    if (!r.ok) throw new Error(r.title);
    Object.assign(net, { up: true, delayMs: 50 });
    const d = await sup.onAppClose(deadline.signal);
    expect(killDone).toBe(true);
    expect(d.stop).toBe(true);
    expect(killed).toEqual([r.core.pid]);
    expect(existsSync(config.sessionPath)).toBe(false);
  });

  it('con un núcleo vivo y una sesión válida lo reutiliza (y lo puede apagar luego)', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(config.sessionPath, encodeSession({ port: PORT, pid: 999_999, token: TOKEN, startedAt: '2026-11-04T10:00:00.000Z' }, cipher));
    const spawned: { command?: string } = {};
    const sup = supervisor({ fetch: fakeFetch({ up: true, running: 0 }), spawn: fakeSpawn('ready', spawned) });
    const r = await sup.connect();
    expect(r).toMatchObject({ ok: true, core: { ownership: 'adopted', pid: 999_999, token: TOKEN } });
    expect(spawned.command).toBeUndefined();
    expect((await sup.onAppClose()).stop).toBe(true);
    expect(killed).toEqual([999_999]);
  });

  it('un núcleo vivo sin sesión (p. ej. el de la flota) no se toca: la app explica qué pasa', async () => {
    const sup = supervisor({ fetch: fakeFetch({ up: true, running: 1 }) });
    const r = await sup.connect();
    expect(r).toMatchObject({ ok: false, title: `Berland no tiene el token del núcleo de 127.0.0.1:${PORT}` });
    expect(await sup.onAppClose()).toMatchObject({ stop: false });
    expect(killed).toEqual([]);
  });

  it('una sesión vieja (el token ya no vale) se borra y tampoco se toca el núcleo', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(config.sessionPath, encodeSession({ port: PORT, pid: 1234, token: 'v'.repeat(43), startedAt: '2026-11-04T10:00:00.000Z' }, cipher));
    const sup = supervisor({ fetch: fakeFetch({ up: true, running: 0 }) });
    expect((await sup.connect()).ok).toBe(false);
    expect(existsSync(config.sessionPath)).toBe(false);
    expect(killed).toEqual([]);
  });

  describe('con ORQ_UI_DEV=1 (interfaz en 5174)', () => {
    const DEV = 'http://127.0.0.1:5174';
    const devConfig = () => ({ ...config, uiDev: true, appOrigin: DEV, startUrl: `${DEV}/` });
    const saveSession = () => {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(config.sessionPath, encodeSession({ port: PORT, pid: 999_999, token: TOKEN, startedAt: '2026-11-04T10:00:00.000Z' }, cipher));
    };

    it('no adopta un núcleo que no acepta el origen de desarrollo, y no lanza otro', async () => {
      config = devConfig();
      saveSession();
      const spawned: { command?: string } = {};
      const r = await supervisor({ fetch: fakeFetch({ up: true, running: 1 }), spawn: fakeSpawn('ready', spawned) }).connect();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.title).toContain('5174');
      expect(spawned.command).toBeUndefined();
      expect(existsSync(config.sessionPath)).toBe(true);
    });

    it('adopta el núcleo si acepta el origen de desarrollo', async () => {
      config = devConfig();
      saveSession();
      const r = await supervisor({ fetch: fakeFetch({ up: true, running: 1, allowedOrigins: [DEV] }) }).connect();
      expect(r).toMatchObject({ ok: true, core: { ownership: 'adopted', pid: 999_999 } });
    });

    it('con ORQ_CORE_TOKEN tampoco acepta un núcleo sin el origen de desarrollo', async () => {
      const token = 'w'.repeat(43);
      config = { ...devConfig(), coreToken: token };
      const r = await supervisor({ fetch: fakeFetch({ up: true, running: 0, token }) }).connect();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.title).toContain('5174');
        expect(r.hint).toBe(`Vuelve a arrancarlo a mano con ORQ_ALLOWED_ORIGINS=${DEV} y usa ORQ_CORE_TOKEN.`);
        expect(r.hint).not.toContain('Vuelve a arráncalo');
      }
    });
  });

  it('ORQ_CORE_TOKEN conecta con un núcleo ajeno que nunca se apaga', async () => {
    const token = 'w'.repeat(43);
    config = { ...config, coreToken: token };
    const sup = supervisor({ fetch: fakeFetch({ up: true, running: 0, token }) });
    expect(await sup.connect()).toMatchObject({ ok: true, core: { ownership: 'external', pid: null } });
    expect((await sup.onAppClose()).stop).toBe(false);
    expect(killed).toEqual([]);
  });

  it('con una sesión guardada y sin núcleo vivo, registra que el anterior terminó sin apagarse', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(config.sessionPath, encodeSession({ port: PORT, pid: 5336, token: 'v'.repeat(43), startedAt: '2026-11-05T00:37:58.000Z' }, cipher));
    const sup = supervisor({ spawn: fakeSpawn('ready', {}) });
    const r = await sup.connect();
    if (!r.ok) throw new Error(r.title);
    const note = 'el núcleo anterior (pid 5336, lanzado 2026-11-05T00:37:58.000Z) terminó sin que Berland lo apagara';
    expect(logs).toContain(note);
    const lines = readFileSync(sup.logPath, 'utf8').split('\n');
    const header = lines.findIndex((l) => l.includes('Berland lanza el núcleo'));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(lines[header + 1]).toBe(note);
    // La sesión nueva pisa la vieja.
    expect(readFileSync(config.sessionPath, 'utf8')).not.toContain('5336');
  });

  it('sin sesión guardada, al lanzar no dice que el anterior terminó', async () => {
    const sup = supervisor({ spawn: fakeSpawn('ready', {}) });
    expect((await sup.connect()).ok).toBe(true);
    expect(logs.some((l) => l.includes('terminó sin que Berland lo apagara'))).toBe(false);
    expect(readFileSync(sup.logPath, 'utf8')).not.toContain('terminó sin que Berland lo apagara');
  });

  it('si el núcleo muere al arrancar, el error trae la cola del registro', async () => {
    const sup = supervisor({ spawn: fakeSpawn('fail', {}) });
    const r = await sup.connect();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.title).toBe('El núcleo no arrancó');
      expect(r.detail).toContain('código 3');
      expect(r.detail).toContain('EADDRINUSE');
      expect(r.hint).toContain(sup.logPath);
    }
    expect(existsSync(config.sessionPath)).toBe(false);
  });

  it('sin node.exe o sin el núcleo en el repo no lanza nada', async () => {
    expect(await supervisor({ nodePath: null }).connect()).toMatchObject({ ok: false, title: 'No encuentro node.exe en el PATH' });
    config = { ...config, repoRoot: join(dir, 'no-existe') };
    expect(await supervisor().connect()).toMatchObject({ ok: false, title: 'No encuentro el núcleo' });
  });

  it('si el antivirus bloquea un instante el rename de la sesión, reintenta y no deja temporales', async () => {
    let fails = 2;
    const flaky = async (from: string, to: string) => {
      if (fails-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      await rename(from, to);
    };
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), rename: flaky });
    const r = await sup.connect();
    expect(r).toMatchObject({ ok: true, core: { sessionSaved: true } });
    expect(decodeSession(readFileSync(config.sessionPath, 'utf8'), cipher)).toMatchObject({ token: TOKEN, port: PORT });
    expect(readdirSync(config.dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('si la sesión no se guarda, no deja el temporal, avisa al cerrar con trabajo y la reapertura no culpa a una terminal', async () => {
    const always = async () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    };
    const net = { up: false, running: 0 };
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), fetch: fakeFetch(net), rename: always });
    const r = await sup.connect();
    expect(r).toMatchObject({ ok: true, core: { ownership: 'launched', sessionSaved: false } });
    expect(readdirSync(config.dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(config.sessionPath)).toBe(false);

    Object.assign(net, { up: true, running: 1 });
    const d = await sup.onAppClose();
    expect(d).toMatchObject({ stop: false, unsavedSession: true });
    expect(killed).toEqual([]);

    const again = await supervisor({ fetch: fakeFetch({ up: true, running: 1 }) }).connect();
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.hint).toContain('Administrador de tareas');
      expect(again.detail).toContain('no pudo guardar su sesión');
    }

    // «Detener núcleo» en el aviso: se apaga aunque tenga trabajo.
    expect(await sup.stopOwnCore()).toBe(true);
    if (r.ok) expect(killed).toEqual([r.core.pid]);
  });

  it('sin safeStorage funciona igual pero no guarda la sesión', async () => {
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), cipher: null });
    expect((await sup.connect()).ok).toBe(true);
    expect(existsSync(config.sessionPath)).toBe(false);
    expect(logs.some((l) => l.includes('safeStorage no está disponible'))).toBe(true);
  });
});
