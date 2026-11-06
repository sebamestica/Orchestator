import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LockManager } from '../../../src/core/locks/index.ts';
import {
  BERLAND_CHROME_NOTE,
  CHROME_GATE_SCRIPT,
  CHROME_ONLY_NOTE,
  CHROME_TAB_NOTE,
  DEFAULT_GATE_IDLE_MS,
  DEFAULT_GATE_WAIT_MS,
  NO_BROWSER_NOTE,
  PluginService,
  type McpStdioSpec,
} from '../../../src/core/plugins/index.ts';
import { systemExe } from '../../../src/core/process/system-exe.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { Plugin } from '../../../src/shared/index.ts';
import { cleanup, fakeLauncher, pluginHarness, tempDir } from './helpers.ts';

afterEach(cleanup);

const pluginMsgs = (messages: { type: string }[]) => messages.filter((m): m is { type: 'plugin'; plugin: Plugin } => m.type === 'plugin').map((m) => m.plugin);
const exists = (p: string) => stat(p).then(() => true, () => false);

async function chromeHarness(mode: string, extra: Parameters<typeof pluginHarness>[0] = {}) {
  return pluginHarness({
    ...extra,
    chrome: { launcher: () => fakeLauncher(mode), browserTimeoutMs: 5000, startTimeoutMs: 10_000, ...extra.chrome },
  });
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid ?? 0;
  await new Promise((r) => child.on('exit', r));
  return pid;
}

function legacyDb(status: string, profile: string) {
  const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
  const db = store.database;
  db.exec('CREATE TABLE plugins_state (id TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT, agents TEXT NOT NULL, steps TEXT NOT NULL, profile TEXT, updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO plugins_state VALUES (?, ?, ?, ?, ?, ?, ?)').run('chrome', status, 'Perfil agente · 32 herramientas', '["claude-main"]', '[]', profile, '2026-11-04T10:00:00.000Z');
  return store;
}

describe('plugin Chrome: Probar conexión (MCP falso por stdio)', () => {
  it('connected con el número de herramientas; publica connecting → connected', async () => {
    const h = await chromeHarness('ok');
    const res = await h.req('POST', '/plugins/chrome/connect', { body: {} });
    expect(res.status).toBe(200);
    const plugin = (res.json as { plugin: Plugin }).plugin;
    expect(plugin).toMatchObject({ id: 'chrome', status: 'connected', detail: 'Tu Chrome personal · 32 herramientas · conexión con tu Chrome comprobada', steps: [], agents: [] });
    expect(pluginMsgs(h.messages).map((p) => p.status)).toEqual(['connecting', 'connected']);
    const list = await h.req('GET', '/plugins');
    expect((list.json as { plugins: Plugin[] }).plugins.map((p) => [p.id, p.status])).toEqual([['chrome', 'connected'], ['canva', 'disconnected']]);
  });

  it('sin depuración remota: error con los pasos de chrome://inspect', async () => {
    const h = await chromeHarness('no-browser');
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.status).toBe('error');
    expect(plugin.detail).toContain('No se pudo conectar con tu Chrome');
    expect(plugin.steps.join('\n')).toContain('chrome://inspect/#remote-debugging');
    expect(plugin.steps.join('\n')).toContain('acepta el aviso');
    expect(plugin.steps.join('\n')).not.toMatch(/agente|chrome-profile/);
  });

  it('el perfil aislado «agente» ya no existe: 400 y nada cambia', async () => {
    const h = await chromeHarness('ok');
    const res = await h.req('POST', '/plugins/chrome/connect', { body: { profile: 'agente' } });
    expect(res.status).toBe(400);
    expect(res.text).toContain('ya no existe');
    expect(h.service.status('chrome').status).toBe('disconnected');
    expect(pluginMsgs(h.messages)).toEqual([]);
    // `personal` sigue siendo válido (contrato compartido).
    expect((await h.req('POST', '/plugins/chrome/connect', { body: { profile: 'personal' } })).status).toBe(200);
  });

  it('el MCP no responde: error por tiempo con el paso de revisar el lanzador', async () => {
    const h = await chromeHarness('hang', { chrome: { startTimeoutMs: 1000 } });
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.status).toBe('error');
    expect(plugin.detail).toContain('no respondió a tiempo');
  });

  it('lanzador por defecto inexistente: error claro sin arrancar nada', async () => {
    const dir = await tempDir();
    const h = await pluginHarness({ chrome: { toolsDir: dir } });
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.status).toBe('error');
    expect(plugin.detail).toBe(`No se encontró el lanzador ${join(dir, 'chrome-personal.cmd')}.`);
  });

  it('con el Chrome en uso por un agente: lista herramientas sin tocar el navegador y dice quién lo usa', async () => {
    const h = await chromeHarness('no-browser');
    const held = await h.locks.acquire('chrome-personal', { agent: 'claude-main', task: 'tarea-x' });
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.status).toBe('connected');
    expect(plugin.detail).toMatch(/^Tu Chrome personal · 32 herramientas · en uso por claude-main \(tarea tarea-x\)/);
    await held.release();
  });

  it('un candado de Berland abandonado (proceso muerto) no impide probar el navegador', async () => {
    const h = await chromeHarness('ok');
    const ghost = new LockManager({ root: h.locksRoot, pid: await deadPid() });
    await ghost.acquire('chrome-personal', { agent: 'codex-main', task: 'tarea-muerta', note: `${BERLAND_CHROME_NOTE} · puerta MCP` });
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.detail).toContain('conexión con tu Chrome comprobada');
    expect(await exists(join(h.locksRoot, 'chrome-personal'))).toBe(false);
  });

  it('dos connect a la vez comparten la misma prueba', async () => {
    const h = await chromeHarness('ok');
    const [a, b] = await Promise.all([h.service.connect('chrome', {}), h.service.connect('chrome', {})]);
    expect(a).toEqual(b);
    expect(pluginMsgs(h.messages).filter((p) => p.status === 'connecting')).toHaveLength(1);
  });

  it('profile solo aplica a Chrome', async () => {
    const h = await chromeHarness('ok');
    const res = await h.req('POST', '/plugins/canva/connect', { body: { profile: 'personal' } });
    expect(res.status).toBe(400);
    expect((await h.req('POST', '/plugins/otro/connect', { body: {} })).status).toBe(400);
  });

  it('un arranque nuevo no deja un connecting colgado', async () => {
    const store = legacyDb('connecting', 'personal');
    const s = new PluginService({ db: store.database, vault: new MemoryVault() });
    expect(s.status('chrome')).toMatchObject({ status: 'disconnected', detail: 'La conexión quedó a medias al reiniciar el núcleo.' });
    s.close();
    store.close();
  });

  it('un estado guardado con el perfil aislado vuelve a tu Chrome personal, desconectado y con el aviso', async () => {
    const store = legacyDb('connected', 'agente');
    const s = new PluginService({ db: store.database, vault: new MemoryVault() });
    expect(s.status('chrome')).toMatchObject({ status: 'disconnected', agents: ['claude-main'] });
    expect(s.status('chrome').detail).toContain('Se quitó el perfil aislado');
    expect(s.status('chrome').steps.join('\n')).toContain('chrome://inspect');
    expect(await s.mcpServersFor('claude-main', 'claude-sdk')).toEqual({});
    s.close();
    store.close();
  });
});

describe('plugin Chrome: entrega a los agentes (una sola vía)', () => {
  it('servidor `chrome-personal` = la puerta delante de `cmd.exe /c <lanzador>`, con la nota de usar solo este navegador', async () => {
    const dir = await tempDir();
    const h = await pluginHarness({ chrome: { toolsDir: dir, probe: async () => ({ ok: true, tools: ['list_pages', 'new_page'], stderr: [] }) } });
    await writeFile(join(dir, 'chrome-personal.cmd'), '@echo off\r\n');
    await h.service.connect('chrome', {});
    const servers = await h.service.mcpServersFor('claude-main', 'claude-sdk');
    expect(Object.keys(servers)).toEqual(['chrome-personal']);
    const spec = servers['chrome-personal'] as McpStdioSpec;
    expect(spec).toMatchObject({ type: 'stdio', command: process.execPath, toolTimeoutSec: DEFAULT_GATE_WAIT_MS / 1000 + 120 });
    expect(spec.args).toEqual([
      CHROME_GATE_SCRIPT, '--lock', 'chrome-personal', '--agent', 'claude-main', '--task', 'sesion', '--locks-root', h.locksRoot,
      '--wait-ms', String(DEFAULT_GATE_WAIT_MS), '--idle-ms', String(DEFAULT_GATE_IDLE_MS), '--', systemExe('cmd.exe'), '/c', join(dir, 'chrome-personal.cmd'),
    ]);
    expect(spec.instructions).toContain(CHROME_ONLY_NOTE);
    expect(spec.instructions).toContain(CHROME_TAB_NOTE);
    expect(spec.instructions).toContain('Nunca abras otro navegador');
    // Determinista: la mente compara su configuración entre mensajes (issue 7).
    expect(await h.service.mcpServersFor('claude-main', 'claude-sdk')).toEqual(servers);
    expect(Object.keys(await h.service.mcpServersFor('codex-main', 'codex-cli'))).toEqual(['chrome-personal']);
    // agy y los agentes de API no reciben servidores MCP.
    expect(await h.service.mcpServersFor('agy-main', 'agy-cli')).toEqual({});
    expect(await h.service.mcpServersFor('api-main', 'api')).toEqual({});
  });

  it('forMind: la mente recibe los servidores con sus instrucciones y, sin Chrome, la nota de no tener navegador', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', {});
    const on = await h.service.forMind('claude-main');
    expect(Object.keys(on.servers)).toEqual(['chrome-personal']);
    expect(on.servers['chrome-personal']?.instructions).toContain(CHROME_TAB_NOTE);
    expect(on.notes).toEqual([]);
    await h.service.disconnect('chrome');
    expect(await h.service.forMind('claude-main')).toEqual({ servers: {}, notes: [NO_BROWSER_NOTE] });
  });

  it('ningún agente recibe un perfil aislado ni otro Chrome', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', {});
    for (const [agent, kind] of [['claude-main', 'claude-sdk'], ['codex-main', 'codex-cli']] as const) {
      const grant = await h.service.grant({ agentId: agent, kind, taskId: 't-1' });
      expect(Object.keys(grant.servers)).toEqual(['chrome-personal']);
      const spec = grant.servers['chrome-personal'] as McpStdioSpec;
      // Lo que se ejecuta: la puerta y el lanzador `--autoConnect`, nunca un perfil propio.
      expect([spec.command, ...spec.args].join(' ')).not.toMatch(/chrome-agente|userDataDir|chrome-profile|--isolated/);
      expect(spec.args.at(-1)).toMatch(/chrome-personal\.cmd$|fake-mcp\.ts$|^ok$/);
      await grant.release();
    }
  });

  it('solo a los agentes elegidos; los demás reciben la nota de no abrir otro navegador; desconectado no se entrega', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', { agents: ['claude-main'] });
    expect(Object.keys(await h.service.mcpServersFor('claude-main', 'claude-sdk'))).toEqual(['chrome-personal']);
    const codex = await h.service.grant({ agentId: 'codex-main', kind: 'codex-cli', taskId: 't-1' });
    expect(codex.servers).toEqual({});
    expect(codex.notes).toEqual([NO_BROWSER_NOTE]);
    await h.req('POST', '/plugins/chrome/disconnect');
    expect(h.service.status('chrome')).toMatchObject({ status: 'disconnected', agents: ['claude-main'] });
    expect(await h.service.mcpServersFor('claude-main', 'claude-sdk')).toEqual({});
    expect((await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 't-2' })).notes).toEqual([NO_BROWSER_NOTE]);
    // agy y API no reciben ni servidores ni la nota.
    expect((await h.service.grant({ agentId: 'agy-main', kind: 'agy-cli', taskId: 't-3' })).notes).toEqual([]);
  });

  it('avisa si se elige un agente que no recibe plugins (agy) o que no existe', async () => {
    const h = await chromeHarness('ok');
    h.registry.put({ id: 'agy-main', kind: 'agy-cli', provider: 'google', displayName: 'agy' });
    const plugin = await h.service.connect('chrome', { agents: ['agy-main', 'fantasma'] });
    expect(plugin.steps.join('\n')).toContain('agy-main (agy) todavía no recibe plugins');
    expect(plugin.steps.join('\n')).toContain('El agente fantasma no está registrado');
  });

  it('dos sesiones a la vez reciben Chrome: el candado lo toma la puerta en la primera llamada, no la sesión', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', {});
    const a = await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 'tarea-a' });
    const b = await h.service.grant({ agentId: 'codex-main', kind: 'codex-cli', taskId: 'Tarea B con espacios' });
    expect(Object.keys(a.servers)).toEqual(['chrome-personal']);
    expect(Object.keys(b.servers)).toEqual(['chrome-personal']);
    expect(await exists(join(h.locksRoot, 'chrome-personal'))).toBe(false);
    expect((b.servers['chrome-personal'] as McpStdioSpec).args).toContain('tarea-b-con-espacios');
    await a.release();
    await a.release(); // idempotente
    await b.release();
  });

  it('release() libera el candado si la puerta de su sesión murió sin soltarlo, y no toca el de otros', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', {});
    const dead = await deadPid();
    const ghost = new LockManager({ root: h.locksRoot, pid: dead });
    const note = `${BERLAND_CHROME_NOTE} · puerta MCP`;

    const other = await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 'tarea-otra' });
    await ghost.acquire('chrome-personal', { agent: 'codex-main', task: 'tarea-a', note });
    await other.release();
    expect(await exists(join(h.locksRoot, 'chrome-personal'))).toBe(true);

    const mine = await h.service.grant({ agentId: 'codex-main', kind: 'codex-cli', taskId: 'tarea-a' });
    await mine.release();
    expect(await exists(join(h.locksRoot, 'chrome-personal'))).toBe(false);
    expect(h.logs.join('\n')).toContain('quedó abandonado y se liberó');

    // Con la puerta viva (este proceso), no se libera.
    const live = await h.locks.acquire('chrome-personal', { agent: 'codex-main', task: 'tarea-b', note });
    const third = await h.service.grant({ agentId: 'codex-main', kind: 'codex-cli', taskId: 'tarea-b' });
    await third.release();
    expect(await readFile(join(h.locksRoot, 'chrome-personal', 'owner'), 'utf8')).toContain('"task":"tarea-b"');
    await live.release();
  });

  it('source() es la McpServerSource de los adaptadores', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', {});
    const grant = await h.service.source()({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 'x1' });
    expect(Object.keys(grant.servers)).toEqual(['chrome-personal']);
    await grant.release();
  });
});

describe('plugin Chrome: estado vivo en GET /plugins (solo lee archivos)', () => {
  async function chromeData(opts: { debugging: boolean; lastUsed?: string }) {
    const dir = await tempDir('orq-chrome-data-');
    await writeFile(join(dir, 'Local State'), JSON.stringify({
      profile: { last_used: opts.lastUsed ?? 'Default', info_cache: { Default: { name: 'S_', gaia_name: 'x' }, 'Profile 6': { name: 'chat58' } } },
      otra: { cosa: 1 },
    }));
    if (opts.debugging) await writeFile(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/abc\n');
    return dir;
  }
  const liveChrome = async (h: Awaited<ReturnType<typeof pluginHarness>>) => ((await h.req('GET', '/plugins')).json as { plugins: Plugin[] }).plugins.find((p) => p.id === 'chrome');

  it('depuración remota, perfil de las pestañas nuevas y «libre»', async () => {
    const userDataDir = await chromeData({ debugging: true });
    const h = await chromeHarness('ok', { chrome: { userDataDir } });
    await h.service.connect('chrome', {});
    const chrome = await liveChrome(h);
    expect(chrome?.detail?.split(' · ')).toEqual([
      'Tu Chrome personal', '32 herramientas', 'conexión con tu Chrome comprobada',
      'Depuración remota activa', 'Pestañas nuevas en tu perfil «S_» (Default), el último que usaste', 'Libre ahora',
    ]);
    // Lo vivo no se guarda ni se publica.
    expect(h.service.status('chrome').detail).toBe('Tu Chrome personal · 32 herramientas · conexión con tu Chrome comprobada');
  });

  it('quién lo usa ahora; depuración apagada; otro perfil', async () => {
    const userDataDir = await chromeData({ debugging: false, lastUsed: 'Profile 6' });
    const h = await chromeHarness('ok', { chrome: { userDataDir }, now: () => new Date(Date.now() + 120_000) });
    const held = await h.locks.acquire('chrome-personal', { agent: 'codex-main', task: 't-1', note: `${BERLAND_CHROME_NOTE} · puerta MCP` });
    const detail = (await liveChrome(h))?.detail ?? '';
    expect(detail).toContain('Depuración remota apagada: actívala en chrome://inspect/#remote-debugging');
    expect(detail).toContain('Pestañas nuevas en tu perfil «chat58» (Profile 6)');
    expect(detail).toMatch(/En uso ahora por codex-main \(tarea t-1\), hace [12] min/);
    await held.release();
  });

  it('un candado abandonado se muestra como libre; sin Local State no inventa el perfil', async () => {
    const h = await chromeHarness('ok');
    const ghost = new LockManager({ root: h.locksRoot, pid: await deadPid() });
    await ghost.acquire('chrome-personal', { agent: 'codex-main', task: 't-1', note: `${BERLAND_CHROME_NOTE} · puerta MCP` });
    const detail = (await liveChrome(h))?.detail ?? '';
    expect(detail).toContain('Libre ahora (el último agente terminó sin soltarlo');
    expect(detail).not.toContain('Pestañas nuevas');
  });

  it('un Local State inválido no rompe la lista', async () => {
    const dir = await tempDir('orq-chrome-data-');
    await mkdir(join(dir, 'Default'));
    await writeFile(join(dir, 'Local State'), '{ no es json');
    const h = await chromeHarness('ok', { chrome: { userDataDir: dir } });
    expect((await h.req('GET', '/plugins')).status).toBe(200);
  });
});
