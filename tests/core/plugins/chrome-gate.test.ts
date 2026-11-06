import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LockManager, type LockHandle } from '../../../src/core/locks/index.ts';
import { encodeOwner } from '../../../src/core/locks/owner.ts';
import { busyText, ChromeGate, parseGateArgs, type GateOptions } from '../../../src/core/plugins/chrome-gate.ts';
import { BERLAND_CHROME_NOTE, CHROME_GATE_SCRIPT, CHROME_LOCK, chromeGateArgs, isAbandonedChromeHolder } from '../../../src/core/plugins/chrome.ts';
import { probeStdioMcp } from '../../../src/core/plugins/mcp-probe.ts';
import { cleanup, fakeLauncher, tempDir } from './helpers.ts';

afterEach(cleanup);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('tiempo agotado esperando la condición');
    await wait(10);
  }
}
const exists = (p: string) => stat(p).then(() => true, () => false);

/** Puerta en proceso con un servidor que guarda lo que recibe y un cliente que guarda lo que le llega. */
async function gate(root: string, over: Partial<GateOptions> = {}, locks?: Pick<LockManager, 'acquire' | 'releaseAbandoned'>) {
  const toServer: string[] = [];
  const toClient: string[] = [];
  const logs: string[] = [];
  const g = new ChromeGate(
    { lock: CHROME_LOCK, agent: 'claude-main', task: 'tarea-a', locksRoot: root, waitMs: 2000, idleMs: 60_000, retryMs: 20, pages: 'own', ...over },
    { toServer: (l) => toServer.push(l), toClient: (l) => toClient.push(l), log: (l) => logs.push(l), ...(locks ? { locks } : {}) },
  );
  cleanups.push(() => g.close());
  const call = (id: number, name = 'new_page', args: Record<string, unknown> = {}) => g.onClientLine(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
  const reply = (id: number, text = 'ok') => g.onServerLine(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }));
  const forwarded = () => toServer.map((l) => JSON.parse(l) as { id?: number; method?: string });
  const answers = () => toClient.map((l) => JSON.parse(l) as { id?: number; result?: { isError?: boolean; content?: { text?: string }[] } });
  return { g, toServer, toClient, logs, call, reply, forwarded, answers };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

/** pid de un proceso que ya terminó (para candados abandonados). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid ?? 0;
  await new Promise((r) => child.on('exit', r));
  return pid;
}

describe('puerta MCP del Chrome personal: argumentos', () => {
  it('lee los argumentos y rechaza los que faltan o sobran', () => {
    const args = chromeGateArgs({ command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'C:\\x\\chrome-personal.cmd'] }, { agent: 'codex-main', task: 't-1', locksRoot: 'C:\\dev\\agent-hub\\locks', waitMs: 1000, idleMs: 2000 });
    expect(args[0]).toBe(CHROME_GATE_SCRIPT);
    expect(parseGateArgs(args.slice(1))).toEqual({
      lock: 'chrome-personal', agent: 'codex-main', task: 't-1', locksRoot: 'C:\\dev\\agent-hub\\locks', waitMs: 1000, idleMs: 2000, retryMs: 1000, pages: 'own',
      command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'C:\\x\\chrome-personal.cmd'],
    });
    expect(() => parseGateArgs(['--lock', 'chrome-personal'])).toThrow(/-- <comando>/);
    const who = ['--agent', 'codex-main', '--task', 'tarea-t'];
    expect(() => parseGateArgs(['--lock', 'chrome-personal', ...who, '--', 'x'])).toThrow(/--locks-root/);
    expect(() => parseGateArgs(['--lock', 'chrome-personal', ...who, '--locks-root', 'relativa', '--', 'x'])).toThrow(/absoluta/);
    expect(() => parseGateArgs(['--lock', 'chrome-personal', ...who, '--locks-root', 'C:\\l', '--otro', '1', '--', 'x'])).toThrow(/desconocido/);
    expect(() => parseGateArgs(['--lock', 'chrome-personal', ...who, '--locks-root', 'C:\\l', '--wait-ms', '-1', '--', 'x'])).toThrow(/≥ 0/);
    expect(parseGateArgs(['--lock', 'chrome-personal', ...who, '--locks-root', 'C:\\l', '--pages', 'all', '--', 'x']).pages).toBe('all');
    expect(() => parseGateArgs(['--lock', 'chrome-personal', ...who, '--locks-root', 'C:\\l', '--pages', 'otra', '--', 'x'])).toThrow(/own o all/);
    expect(() => parseGateArgs(['--lock', '../fuera', ...who, '--locks-root', 'C:\\l', '--', 'x'])).toThrow();
    expect(() => parseGateArgs(['--lock', 'chrome-personal', '--agent', 'Con Espacios', '--task', 'tarea-t', '--locks-root', 'C:\\l', '--', 'x'])).toThrow();
  });

  it('el texto de ocupado dice quién lo tiene y que no abra otro navegador', () => {
    const text = busyText({ format: 'json', agent: 'codex-main', task: 't-1', at: '2026-11-04T12:00:00.000Z' }, 300_000, new Date('2026-11-04T12:07:00.000Z'));
    expect(text).toContain('codex-main (tarea t-1), hace 7 min');
    expect(text).toContain('tras esperar 5 min');
    expect(text).toContain('No abras otro navegador');
  });
});

describe('puerta MCP del Chrome personal: candado perezoso', () => {
  it('initialize y tools/list pasan sin candado; la primera tools/call lo toma y lo suelta al quedar ociosa', async () => {
    const root = await tempDir('orq-gate-');
    const t = await gate(root, { idleMs: 80 });
    t.g.onClientLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    t.g.onClientLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(t.forwarded().map((m) => m.method)).toEqual(['initialize', 'tools/list']);
    t.g.onClientLine('no es json');
    expect(t.toServer.at(-1)).toBe('no es json');
    t.toServer.pop();
    expect(await exists(join(root, CHROME_LOCK))).toBe(false);

    t.call(3);
    await until(() => t.toServer.length === 3);
    const owner = await readFile(join(root, CHROME_LOCK, 'owner'), 'utf8');
    expect(owner).toContain('"agent":"claude-main"');
    expect(owner).toContain('"task":"tarea-a"');
    expect(owner).toContain(BERLAND_CHROME_NOTE);
    expect(t.g.holding).toBe(true);

    t.reply(3);
    expect(t.answers().at(-1)).toMatchObject({ id: 3, result: { content: [{ text: 'ok' }] } });
    // Con la llamada respondida, al pasar el tiempo ocioso suelta el candado.
    await until(() => t.logs.join('\n').includes('soltado (inactividad)'));
    expect(await exists(join(root, CHROME_LOCK))).toBe(false);
    expect(t.g.holding).toBe(false);
  });

  it('serializa: con el Chrome en uso por otra puerta, la llamada espera y entra cuando se suelta', async () => {
    const root = await tempDir('orq-gate-');
    const a = await gate(root, { agent: 'codex-main', task: 't-1', idleMs: 50 });
    const b = await gate(root, { agent: 'claude-main', task: 't-2', waitMs: 5000 });
    a.call(1);
    await until(() => a.toServer.length === 1);
    b.call(7);
    await wait(150);
    // B no pasa nada al servidor mientras A tiene la llamada en curso.
    expect(b.toServer).toEqual([]);
    expect(b.toClient).toEqual([]);
    expect(b.logs.join('\n')).toMatch(/ocupado por codex-main \(tarea t-1\).*esperando/);
    a.reply(1);
    await until(() => b.toServer.length === 1, 4000);
    expect(b.forwarded()[0]).toMatchObject({ id: 7, method: 'tools/call' });
    expect(await readFile(join(root, CHROME_LOCK, 'owner'), 'utf8')).toContain('"task":"t-2"');
  });

  it('si sigue ocupado tras la espera, responde la llamada con un error claro y no la pasa al servidor', async () => {
    const root = await tempDir('orq-gate-');
    const a = await gate(root, { agent: 'codex-main', task: 't-1' });
    a.call(1);
    await until(() => a.toServer.length === 1);
    const b = await gate(root, { waitMs: 120 });
    b.call(9);
    await until(() => b.toClient.length === 1);
    expect(b.toServer).toEqual([]);
    const answer = b.answers()[0];
    expect(answer).toMatchObject({ id: 9, result: { isError: true } });
    expect(answer?.result?.content?.[0]?.text).toContain('codex-main (tarea t-1)');
    expect(answer?.result?.content?.[0]?.text).toContain('No abras otro navegador');
    expect(b.g.holding).toBe(false);
  });

  it('respeta el candado en texto de la skill (agy u otro agente que siga local-compute-scheduling)', async () => {
    const root = await tempDir('orq-gate-');
    await mkdir(join(root, CHROME_LOCK));
    await writeFile(join(root, CHROME_LOCK, 'owner'), 'agy-main investigar 2026-11-04T12:00:00-03:00\n');
    const t = await gate(root, { waitMs: 100 });
    t.call(1);
    await until(() => t.toClient.length === 1);
    expect(t.answers()[0]?.result?.content?.[0]?.text).toContain('agy-main');
    expect(await readFile(join(root, CHROME_LOCK, 'owner'), 'utf8')).toContain('agy-main');
  });

  it('libera el candado de una puerta de esta máquina cuyo proceso ya no existe, y lo toma', async () => {
    const root = await tempDir('orq-gate-');
    const pid = await deadPid();
    const ghost = new LockManager({ root, pid });
    await ghost.acquire(CHROME_LOCK, { agent: 'codex-main', task: 't-muerta', note: `${BERLAND_CHROME_NOTE} · puerta MCP` });
    const t = await gate(root);
    t.call(1);
    await until(() => t.toServer.length === 1);
    expect(await readFile(join(root, CHROME_LOCK, 'owner'), 'utf8')).toContain('"task":"tarea-a"');
    expect(t.logs.join('\n')).toContain(`pid ${pid} ya no existe`);
  });

  it('un candado ajeno a Berland con pid muerto no se toca', async () => {
    const root = await tempDir('orq-gate-');
    const pid = await deadPid();
    await mkdir(join(root, CHROME_LOCK));
    await writeFile(join(root, CHROME_LOCK, 'owner'), encodeOwner({ agent: 'otro', task: 'tarea-x', pid, host: hostname(), at: new Date().toISOString(), note: 'blender', tokenHash: 'a'.repeat(64) }));
    const t = await gate(root, { waitMs: 80 });
    t.call(1);
    await until(() => t.toClient.length === 1);
    expect(t.answers()[0]?.result?.isError).toBe(true);
    expect(isAbandonedChromeHolder({ format: 'json', agent: 'otro', task: 'x', pid, host: hostname(), note: 'blender' })).toBe(false);
    expect(isAbandonedChromeHolder({ format: 'json', agent: 'otro', task: 'x', pid, host: 'otra-maquina', note: BERLAND_CHROME_NOTE })).toBe(false);
    expect(isAbandonedChromeHolder({ format: 'json', agent: 'otro', task: 'x', pid: process.pid, host: hostname(), note: BERLAND_CHROME_NOTE })).toBe(false);
    expect(isAbandonedChromeHolder({ format: 'json', agent: 'otro', task: 'x', pid, host: hostname(), note: BERLAND_CHROME_NOTE })).toBe(true);
  });

  it('una llamada cancelada mientras espera no llega al servidor ni se responde', async () => {
    const root = await tempDir('orq-gate-');
    const a = await gate(root, { agent: 'codex-main', task: 't-1', idleMs: 30 });
    a.call(1);
    await until(() => a.toServer.length === 1);
    const b = await gate(root, { waitMs: 3000 });
    b.call(5);
    await wait(60);
    b.g.onClientLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } }));
    a.reply(1);
    await wait(400);
    expect(b.toServer).toEqual([]);
    expect(b.toClient).toEqual([]);
    expect(b.g.holding).toBe(false);
  });

  it('una llamada cancelada que ya llegó al servidor deja de contar y el candado se suelta aunque el servidor no responda', async () => {
    const root = await tempDir('orq-gate-');
    const t = await gate(root, { idleMs: 30 });
    t.call(7);
    await until(() => t.toServer.length === 1);
    expect(t.g.holding).toBe(true);
    t.g.onClientLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }));
    // El servidor tiene que enterarse para abortar.
    expect(t.forwarded().at(-1)).toMatchObject({ method: 'notifications/cancelled' });
    await until(() => !t.g.holding);
    expect(await exists(join(root, CHROME_LOCK))).toBe(false);
    // No quedó ningún id huérfano: una llamada nueva vuelve a soltarlo al quedar ociosa.
    t.call(8);
    await until(() => t.g.holding && t.toServer.length === 3);
    t.reply(8);
    await until(() => !t.g.holding);
    expect(await exists(join(root, CHROME_LOCK))).toBe(false);
  });

  it('close() suelta el candado', async () => {
    const root = await tempDir('orq-gate-');
    const t = await gate(root);
    t.call(1);
    await until(() => t.toServer.length === 1);
    await t.g.close();
    expect(await exists(join(root, CHROME_LOCK))).toBe(false);
  });
});

/** Puerta en proceso con el gestor de candados que dé la prueba. */
function gateWith(root: string, locks: Pick<LockManager, 'acquire' | 'releaseAbandoned'>) {
  const toServer: string[] = [];
  const g = new ChromeGate(
    { lock: CHROME_LOCK, agent: 'claude-main', task: 'tarea-a', locksRoot: root, waitMs: 2000, idleMs: 60_000, retryMs: 20, pages: 'own' },
    { toServer: (l) => toServer.push(l), toClient: () => undefined, locks },
  );
  cleanups.push(() => g.close());
  g.onClientLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'new_page', arguments: {} } }));
  return { g, toServer };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('puerta MCP del Chrome personal: cierre durante la toma', () => {
  it('close() espera la toma en curso y suelta el candado una sola vez', async () => {
    const root = await tempDir('orq-gate-');
    const pending = deferred<LockHandle>();
    const acquire = vi.fn(() => pending.promise);
    const t = gateWith(root, { acquire, releaseAbandoned: vi.fn(async () => undefined) });
    await until(() => acquire.mock.calls.length === 1);
    let closed = false;
    const closing = t.g.close().then(() => { closed = true; });
    await wait(30);
    expect(closed).toBe(false);
    const release = vi.fn(async () => undefined);
    pending.resolve({ name: CHROME_LOCK, path: join(root, CHROME_LOCK), owner: { agent: 'claude-main', task: 'tarea-a', pid: process.pid, host: hostname(), at: new Date().toISOString() }, token: 'a'.repeat(32), release });
    await closing;
    expect(release).toHaveBeenCalledTimes(1);
    expect(t.g.holding).toBe(false);
    expect(t.toServer).toEqual([]);
  });

  it('con el gestor real, cerrar en pleno mkdir del candado no deja la carpeta ni un owner', async () => {
    const root = await tempDir('orq-gate-');
    const brake = deferred<void>();
    let braked = false;
    const locks = new LockManager({
      root,
      fs: {
        mkdir: (p, o) => {
          if (!p.endsWith(CHROME_LOCK)) return mkdir(p, o);
          braked = true;
          return brake.promise.then(() => mkdir(p, o));
        },
      },
    });
    const t = gateWith(root, locks);
    await until(() => braked);
    const closing = t.g.close();
    brake.resolve();
    await closing;
    // Deja terminar la toma que estaba frenada: no debe quedar nada después.
    await wait(200);
    expect(await exists(join(root, CHROME_LOCK))).toBe(false);
    expect(t.toServer).toEqual([]);
  });
});

/** Gestor real cuyo rename al soltar falla con EPERM (Defender o un lector con `owner` abierto) las primeras `failures` veces. */
function flakyRelease(root: string, failures: number) {
  let left = failures;
  return new LockManager({
    root,
    fs: {
      rename: async (from, to) => {
        if (to.includes('.releasing.') && left > 0) {
          left--;
          throw Object.assign(new Error('EPERM: simulado, rename'), { code: 'EPERM', syscall: 'rename' });
        }
        return rename(from, to);
      },
    },
  });
}

describe('puerta MCP del Chrome personal: soltar que falla', () => {
  it('si soltar falla por un error pasajero conserva el candado: la siguiente llamada pasa y después lo suelta', async () => {
    const root = await tempDir('orq-gate-');
    // 6 fallos = una liberación entera de LockManager (1 intento + 5 reintentos).
    const t = await gate(root, { idleMs: 50, waitMs: 300, retryMs: 20 }, flakyRelease(root, 6));
    t.call(1);
    await until(() => t.toServer.length === 1);
    t.reply(1);
    await until(() => t.logs.join('\n').includes('no se pudo soltar'));
    expect(await exists(join(root, CHROME_LOCK))).toBe(true);
    expect(t.g.holding).toBe(true);
    t.call(2);
    await until(() => t.forwarded().some((m) => m.id === 2));
    expect(t.answers().some((a) => a.result?.isError)).toBe(false);
    t.reply(2);
    await until(() => t.logs.join('\n').includes('soltado (inactividad)'));
    expect(await exists(join(root, CHROME_LOCK))).toBe(false);
  });

  it('sin más llamadas reintenta soltar, y otra puerta que esperaba entra', async () => {
    const root = await tempDir('orq-gate-');
    const a = await gate(root, { agent: 'claude-main', task: 't-1', idleMs: 50 }, flakyRelease(root, 6));
    const b = await gate(root, { agent: 'codex-main', task: 't-2', waitMs: 4000 });
    a.call(1);
    await until(() => a.toServer.length === 1);
    b.call(7);
    a.reply(1);
    await until(() => a.logs.join('\n').includes('no se pudo soltar'));
    await until(() => b.toServer.length === 1, 4000);
    expect(b.forwarded()[0]).toMatchObject({ id: 7, method: 'tools/call' });
    expect(a.logs.join('\n')).toContain('soltado (inactividad)');
    expect(await readFile(join(root, CHROME_LOCK, 'owner'), 'utf8')).toContain('"task":"t-2"');
  });
});

const PAGES = '## Pages\n1: Recibidos (https://mail.test/)\n2: A (https://a.test/) [selected]';

describe('puerta MCP del Chrome personal: solo tus pestañas', () => {
  /** Puerta con una pestaña propia (2) abierta con `new_page`; la 1 es del usuario. */
  async function withOwnTab(over: Partial<GateOptions> = {}) {
    const t = await gate(await tempDir('orq-gate-'), over);
    t.call(1, 'new_page', { url: 'https://a.test' });
    await until(() => t.toServer.length === 1);
    t.reply(1, PAGES);
    const text = (id: number) => t.answers().find((a) => a.id === id)?.result?.content?.[0]?.text;
    const sent = (id: number) => t.forwarded().some((m) => m.id === id);
    return { ...t, text, sent };
  }

  it('new_page anota la pestaña nueva y la respuesta oculta las ajenas', async () => {
    const t = await withOwnTab();
    expect(t.text(1)).toBe('## Pages\n1: (pestaña que no abriste)\n2: A (https://a.test/) [selected]');
  });

  it('rechaza sin pasarlas al servidor las llamadas con el pageId de una pestaña ajena', async () => {
    const t = await withOwnTab();
    t.call(2, 'take_snapshot', { pageId: 2 });
    await until(() => t.sent(2));
    t.reply(2);
    t.call(3, 'take_snapshot', { pageId: 1 });
    t.call(4, 'select_page', { pageId: 1 });
    t.call(5, 'close_page', { pageId: 1 });
    t.call(6, 'evaluate_script', { pageId: 1, function: '() => 1' });
    t.call(7, 'evaluate_script', { pageId: 0, function: '() => 1' });
    await wait(50);
    for (const id of [3, 4, 5, 6, 7]) {
      expect(t.sent(id)).toBe(false);
      expect(t.answers().find((a) => a.id === id)?.result?.isError).toBe(true);
      expect(t.text(id)).toContain('no la abriste');
    }
  });

  it('list_pages pasa y llega con las ajenas ocultas; tras close_page la propia pasa a ser ajena', async () => {
    const t = await withOwnTab();
    t.call(2, 'list_pages');
    await until(() => t.sent(2));
    t.reply(2, PAGES);
    expect(t.text(2)).toBe('## Pages\n1: (pestaña que no abriste)\n2: A (https://a.test/) [selected]');
    t.call(3, 'close_page', { pageId: 2 });
    await until(() => t.sent(3));
    t.reply(3, '## Pages\n1: Recibidos (https://mail.test/) [selected]');
    expect(t.text(3)).toBe('## Pages\n1: (pestaña que no abriste)');
    t.call(4, 'take_snapshot', { pageId: 2 });
    expect(t.sent(4)).toBe(false);
    expect(t.text(4)).toContain('no la abriste');
  });

  it('«Page ids have changed» vacía las pestañas propias', async () => {
    const t = await withOwnTab();
    t.call(2, 'list_pages');
    await until(() => t.sent(2));
    t.reply(2, 'Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.');
    t.call(3, 'take_snapshot', { pageId: 2 });
    expect(t.sent(3)).toBe(false);
    expect(t.text(3)).toContain('no la abriste');
  });

  it('con --pages all todo pasa como antes', async () => {
    const t = await withOwnTab({ pages: 'all' });
    expect(t.text(1)).toBe(PAGES);
    t.call(2, 'take_snapshot', { pageId: 1 });
    await until(() => t.sent(2));
  });
});

describe('puerta MCP del Chrome personal: proceso real', () => {
  it('node chrome-gate.ts … -- <MCP>: el agente ve las herramientas, list_pages pasa y al cerrar stdin suelta el candado', async () => {
    const root = await tempDir('orq-gate-');
    const fake = fakeLauncher('ok');
    const args = chromeGateArgs(fake, { agent: 'codex-main', task: 't-e2e', locksRoot: root, waitMs: 2000, idleMs: 60_000 });
    const result = await probeStdioMcp({ command: process.execPath, args, startTimeoutMs: 20_000, call: { name: 'list_pages', timeoutMs: 10_000 }, closeGraceMs: 5000 });
    // La pestaña del MCP falso no la abrió este agente: llega oculta.
    expect(result).toMatchObject({ ok: true, callText: '## Pages\n1: (pestaña que no abriste)' });
    expect(result.tools).toHaveLength(32);
    await until(async () => !(await exists(join(root, CHROME_LOCK))), 8000);
  }, 30_000);

  it('sin argumentos válidos termina con código 2 y el uso', async () => {
    const child = spawn(process.execPath, [CHROME_GATE_SCRIPT, '--lock', 'chrome-personal'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const code = await new Promise((r) => child.on('exit', r));
    expect(code).toBe(2);
    expect(err).toContain('Uso: node chrome-gate.ts');
  }, 20_000);
});
