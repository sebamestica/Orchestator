import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHROME_TAB_NOTE, PluginService, type ChromeProfile } from '../../../src/core/plugins/index.ts';
import { systemExe } from '../../../src/core/process/system-exe.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { Plugin } from '../../../src/shared/index.ts';
import { cleanup, fakeLauncher, pluginHarness, tempDir } from './helpers.ts';

afterEach(cleanup);

const pluginMsgs = (messages: { type: string }[]) => messages.filter((m): m is { type: 'plugin'; plugin: Plugin } => m.type === 'plugin').map((m) => m.plugin);

async function chromeHarness(mode: string | ((p: ChromeProfile) => string), extra: Parameters<typeof pluginHarness>[0] = {}) {
  return pluginHarness({
    ...extra,
    chrome: { launcher: (p) => fakeLauncher(typeof mode === 'string' ? mode : mode(p)), browserTimeoutMs: 5000, startTimeoutMs: 10_000, ...extra.chrome },
  });
}

describe('plugin Chrome: connect con prueba real (MCP falso por stdio)', () => {
  it('perfil personal: connected con el perfil y el número de herramientas; publica connecting → connected', async () => {
    const h = await chromeHarness('ok');
    const res = await h.req('POST', '/plugins/chrome/connect', { body: { profile: 'personal' } });
    expect(res.status).toBe(200);
    const plugin = (res.json as { plugin: Plugin }).plugin;
    expect(plugin).toMatchObject({ id: 'chrome', status: 'connected', detail: 'Perfil personal · 32 herramientas', steps: [], agents: [] });
    expect(pluginMsgs(h.messages).map((p) => p.status)).toEqual(['connecting', 'connected']);
    const list = await h.req('GET', '/plugins');
    expect((list.json as { plugins: Plugin[] }).plugins.map((p) => [p.id, p.status])).toEqual([['chrome', 'connected'], ['canva', 'disconnected']]);
  });

  it('sin depuración remota: error con los pasos de chrome://inspect', async () => {
    const h = await chromeHarness('no-browser');
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.status).toBe('error');
    expect(plugin.detail).toContain('no se pudo conectar con tu Chrome');
    expect(plugin.steps.join('\n')).toContain('chrome://inspect/#remote-debugging');
    expect(plugin.steps.join('\n')).toContain('acepta el aviso');
  });

  it('perfil agente con Chrome ya abierto en ese perfil: error con el paso de cerrarlo', async () => {
    const h = await chromeHarness('already-running');
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: { profile: 'agente' } })).json as { plugin: Plugin };
    expect(plugin).toMatchObject({ status: 'error' });
    expect(plugin.detail).toContain('ya hay un Chrome abierto con el perfil de los agentes');
    expect(plugin.steps[0]).toContain('Cierra la ventana');
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
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: { profile: 'agente' } })).json as { plugin: Plugin };
    expect(plugin.status).toBe('error');
    expect(plugin.detail).toBe(`No se encontró el lanzador ${join(dir, 'chrome-agente.cmd')}.`);
  });

  it('con el candado del perfil tomado por un agente: lista herramientas sin tocar el navegador', async () => {
    const h = await chromeHarness('no-browser');
    const held = await h.locks.acquire('chrome-personal', { agent: 'claude-main', task: 'tarea-x' });
    const { plugin } = (await h.req('POST', '/plugins/chrome/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.status).toBe('connected');
    expect(plugin.detail).toMatch(/^Perfil personal · 32 herramientas · en uso por claude-main\/tarea-x/);
    await held.release();
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
    const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
    const db = store.database;
    db.exec("CREATE TABLE plugins_state (id TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT, agents TEXT NOT NULL, steps TEXT NOT NULL, profile TEXT, updated_at TEXT NOT NULL)");
    db.prepare('INSERT INTO plugins_state VALUES (?, ?, ?, ?, ?, ?, ?)').run('chrome', 'connecting', null, '[]', '[]', 'agente', '2026-11-04T10:00:00.000Z');
    const s = new PluginService({ db, vault: new MemoryVault() });
    expect(s.status('chrome')).toMatchObject({ status: 'disconnected', detail: 'La conexión quedó a medias al reiniciar el núcleo.' });
    s.close();
    store.close();
  });
});

describe('plugin Chrome: entrega a los agentes', () => {
  it('servidor stdio `cmd.exe /c <lanzador>` (ruta absoluta de cmd.exe) con la nota de la pestaña propia', async () => {
    const dir = await tempDir();
    const h = await pluginHarness({ chrome: { toolsDir: dir, probe: async () => ({ ok: true, tools: ['list_pages', 'new_page'], stderr: [] }) } });
    // Lanzador presente (vacío): el servicio comprueba que exista antes de probar.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'chrome-personal.cmd'), '@echo off\r\n');
    await h.service.connect('chrome', { profile: 'personal' });
    const servers = await h.service.mcpServersFor('claude-main', 'claude-sdk');
    expect(Object.keys(servers)).toEqual(['chrome-personal']);
    expect(servers['chrome-personal']).toMatchObject({ type: 'stdio', command: systemExe('cmd.exe'), args: ['/c', join(dir, 'chrome-personal.cmd')] });
    expect(servers['chrome-personal']?.instructions).toContain(CHROME_TAB_NOTE);
    expect(servers['chrome-personal']?.instructions).toContain('sesiones reales');
    expect(Object.keys(await h.service.mcpServersFor('codex-main', 'codex-cli'))).toEqual(['chrome-personal']);
    // agy y los agentes de API no reciben servidores MCP.
    expect(await h.service.mcpServersFor('agy-main', 'agy-cli')).toEqual({});
    expect(await h.service.mcpServersFor('api-main', 'api')).toEqual({});
  });

  it('solo a los agentes elegidos; desconectado no se entrega; el perfil agente usa chrome-agente', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', { profile: 'agente', agents: ['claude-main'] });
    expect(Object.keys(await h.service.mcpServersFor('claude-main', 'claude-sdk'))).toEqual(['chrome-agente']);
    expect(await h.service.mcpServersFor('codex-main', 'codex-cli')).toEqual({});
    await h.req('POST', '/plugins/chrome/disconnect');
    expect(h.service.status('chrome')).toMatchObject({ status: 'disconnected', agents: ['claude-main'] });
    expect(await h.service.mcpServersFor('claude-main', 'claude-sdk')).toEqual({});
  });

  it('avisa si se elige un agente que no recibe plugins (agy) o que no existe', async () => {
    const h = await chromeHarness('ok');
    h.registry.put({ id: 'agy-main', kind: 'agy-cli', provider: 'google', displayName: 'agy' });
    const plugin = await h.service.connect('chrome', { agents: ['agy-main', 'fantasma'] });
    expect(plugin.steps.join('\n')).toContain('agy-main (agy) todavía no recibe plugins');
    expect(plugin.steps.join('\n')).toContain('El agente fantasma no está registrado');
  });

  it('candado chrome-<perfil> por ejecución: una segunda sesión no recibe Chrome hasta que la primera lo suelta', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', { profile: 'personal' });
    const a = await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 'tarea-a' });
    expect(Object.keys(a.servers)).toEqual(['chrome-personal']);
    const info = await import('node:fs/promises').then((fs) => fs.readFile(join(h.locksRoot, 'chrome-personal', 'owner'), 'utf8'));
    expect(info).toContain('"agent":"claude-main"');
    expect(info).toContain('"task":"tarea-a"');

    const b = await h.service.grant({ agentId: 'codex-main', kind: 'codex-cli', taskId: 'Tarea B con espacios' });
    expect(b.servers).toEqual({});
    expect(b.notes.join('\n')).toMatch(/Chrome \(perfil personal\) está en uso por claude-main\/tarea-a/);

    await a.release();
    await a.release(); // idempotente
    const c = await h.service.grant({ agentId: 'codex-main', kind: 'codex-cli', taskId: 'Tarea B con espacios' });
    expect(Object.keys(c.servers)).toEqual(['chrome-personal']);
    const owner = await import('node:fs/promises').then((fs) => fs.readFile(join(h.locksRoot, 'chrome-personal', 'owner'), 'utf8'));
    expect(owner).toContain('"task":"tarea-b-con-espacios"');
    await c.release();
  });

  it('source() es la McpServerSource de los adaptadores', async () => {
    const h = await chromeHarness('ok');
    await h.service.connect('chrome', {});
    const grant = await h.service.source()({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 'x1' });
    expect(Object.keys(grant.servers)).toEqual(['chrome-personal']);
    await grant.release();
  });
});
