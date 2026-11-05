import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreSupervisor, type SpawnFn } from '../../apps/desktop/src/core-supervisor.ts';
import { loadDesktopConfig, type DesktopConfig } from '../../apps/desktop/src/lib/config.ts';
import type { FetchLike } from '../../apps/desktop/src/lib/core-client.ts';
import { encodeSession, type Cipher } from '../../apps/desktop/src/lib/session-file.ts';

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

/** `fetch` falso: núcleo caído hasta que «arranca»; luego /tasks con el token correcto. */
function fakeFetch(state: { up: boolean; running: number; token?: string }): FetchLike {
  return async (url, init) => {
    if (!state.up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
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
    expect(r).toMatchObject({ ok: false, title: `Ya hay un núcleo en 127.0.0.1:${PORT} que no abrió Berland` });
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

  it('ORQ_CORE_TOKEN conecta con un núcleo ajeno que nunca se apaga', async () => {
    const token = 'w'.repeat(43);
    config = { ...config, coreToken: token };
    const sup = supervisor({ fetch: fakeFetch({ up: true, running: 0, token }) });
    expect(await sup.connect()).toMatchObject({ ok: true, core: { ownership: 'external', pid: null } });
    expect((await sup.onAppClose()).stop).toBe(false);
    expect(killed).toEqual([]);
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

  it('sin safeStorage funciona igual pero no guarda la sesión', async () => {
    const sup = supervisor({ spawn: fakeSpawn('ready', {}), cipher: null });
    expect((await sup.connect()).ok).toBe(true);
    expect(existsSync(config.sessionPath)).toBe(false);
    expect(logs.some((l) => l.includes('safeStorage no está disponible'))).toBe(true);
  });
});
