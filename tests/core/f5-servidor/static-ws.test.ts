import { symlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createF5ServerRoutes } from '../../../src/core/app/f5-servidor.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, generateToken, protocolToken, startServer, type HubMessage, type RunningServer } from '../../../src/core/server/index.ts';
import { IMMUTABLE_CACHE, safeAssetSegments, UI_MISSING_TEXT } from '../../../src/core/server/static.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { cleanupDirs, makeF5App, tempDir, writeFiles } from './helpers.ts';

const running: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of running.splice(0)) await s.close();
  await cleanupDirs();
});

const INDEX = '<!doctype html><html><head><script type="module" src="./assets/app-abc123.js"></script></head><body></body></html>';

/** `dist/ui` falso con un secreto al lado (fuera de la carpeta servida). */
async function uiFixture() {
  const root = await tempDir();
  const ui = join(root, 'ui');
  await writeFiles(root, {
    'ui/index.html': INDEX,
    'ui/assets/app-abc123.js': 'console.log("hola")',
    'ui/assets/estilo-1.css': 'body{}',
    'ui/assets/geist-latin.woff2': 'wOF2',
    'ui/assets/.oculto': 'no',
    'ui/assets/sub/logo.svg': '<svg/>',
    'secreto.txt': 'NO-DEBE-SALIR',
    'ui/otra.html': 'fuera de la lista',
  });
  return ui;
}

describe('interfaz estática sin token', () => {
  it('sirve /, /index.html y /assets/* sin token, con MIME, caché y CSP de la interfaz', async () => {
    const t = makeF5App({ uiDir: await uiFixture() });
    for (const path of ['/', '/index.html']) {
      const res = await t.req('GET', path, { token: null });
      expect(res.status, path).toBe(200);
      expect(res.text).toBe(INDEX);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self' ws://127.0.0.1:47811");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const cases: [string, string][] = [
      ['/assets/app-abc123.js', 'text/javascript; charset=utf-8'],
      ['/assets/estilo-1.css', 'text/css; charset=utf-8'],
      ['/assets/geist-latin.woff2', 'font/woff2'],
      ['/assets/sub/logo.svg', 'image/svg+xml'],
    ];
    for (const [path, type] of cases) {
      const res = await t.req('GET', path, { token: null });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    }
    const head = await t.req('HEAD', '/assets/app-abc123.js', { token: null });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(head.headers.get('content-length')).toBe(String('console.log("hola")'.length));
  });

  it('rechaza .., separadores codificados, ocultos y carpetas; nunca sale de dist/ui', async () => {
    const t = makeF5App({ uiDir: await uiFixture() });
    const attempts = [
      '/assets/..%2f..%2fsecreto.txt',
      '/assets/..%5c..%5csecreto.txt',
      '/assets/%2e%2e%2f%2e%2e%2fsecreto.txt',
      '/assets/sub%2f..%2f..%2f..%2fsecreto.txt',
      '/assets/.oculto',
      '/assets/C:%5cWindows%5cwin.ini',
      '/assets/%00',
      '/assets/',
      '/assets/sub',
      '/assets/sub/',
      '/assets/no-existe.js',
    ];
    for (const path of attempts) {
      const res = await t.req('GET', path, { token: null });
      expect([400, 404], `${path} → ${res.status}`).toContain(res.status);
      expect(res.text).not.toContain('NO-DEBE-SALIR');
      expect(res.text).not.toContain('<svg');
    }
    // Lo que el parser de URL normaliza (`/assets/../x` → `/x`) ya no es estático: va al token.
    for (const path of ['/assets/../secreto.txt', '/assets/%2e%2e/%2e%2e/secreto.txt', '/otra.html', '/favicon.ico']) {
      const res = await t.req('GET', path, { token: null });
      expect(res.status, path).toBe(401);
      expect(res.text).not.toContain('NO-DEBE-SALIR');
    }
    expect(safeAssetSegments('/assets/a/b.js')).toEqual(['a', 'b.js']);
    // Un enlace (unión en Windows) dentro de assets que apunta fuera tampoco sirve lo de fuera.
    const ui = (await uiFixture());
    const outside = join(ui, '..', 'fuera');
    await writeFiles(outside, { 'clave.txt': 'NO-DEBE-SALIR' });
    await symlink(outside, join(ui, 'assets', 'enlace'), 'junction');
    const linked = makeF5App({ uiDir: ui });
    const res = await linked.req('GET', '/assets/enlace/clave.txt', { token: null });
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('NO-DEBE-SALIR');
    expect(safeAssetSegments('/assets/a/../b.js')).toBeUndefined();
  });

  it('solo GET y HEAD: un POST a / sigue exigiendo el token; la API sin token sigue en 401', async () => {
    const t = makeF5App({ uiDir: await uiFixture() });
    expect((await t.req('POST', '/', { token: null })).status).toBe(401);
    for (const path of ['/settings', '/health', '/agents', '/fs/list', '/ws']) {
      const res = await t.req('GET', path, { token: null });
      expect(res.status, path).toBe(401);
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    }
    // Con token, la API responde como siempre (y no-store).
    const ok = await t.req('GET', '/settings');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('sin dist/ui: / responde 404 con un texto claro', async () => {
    const t = makeF5App({ uiDir: join(await tempDir(), 'no-compilada') });
    const res = await t.req('GET', '/', { token: null });
    expect(res.status).toBe(404);
    expect(res.text).toBe(UI_MISSING_TEXT);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  });

  it('el Host sigue comprobándose antes de servir la interfaz', async () => {
    const t = makeF5App({ uiDir: await uiFixture() });
    expect((await t.req('GET', '/', { token: null, headers: { host: 'evil.example:47811' } })).status).toBe(403);
  });
});

describe('Origin', () => {
  it('acepta el origen propio del núcleo (mismo Host) y rechaza uno ajeno', async () => {
    const t = makeF5App({ uiDir: await uiFixture() });
    expect((await t.req('GET', '/settings', { headers: { origin: 'http://127.0.0.1:47811' } })).status).toBe(200);
    expect((await t.req('GET', '/settings', { headers: { origin: 'http://localhost:47811', host: 'localhost:47811' } })).status).toBe(200);
    for (const origin of ['https://evil.example', 'http://127.0.0.1:47812', 'http://localhost:47811', 'https://127.0.0.1:47811', 'null']) {
      const res = await t.req('GET', '/settings', { headers: { origin } });
      expect(res.status, origin).toBe(403);
      expect(res.json).toMatchObject({ error: { code: 'forbidden_origin' } });
    }
    expect((await t.req('GET', '/', { token: null, headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('ORQ_ALLOWED_ORIGINS sigue sirviendo para vite dev (http://127.0.0.1:5174)', async () => {
    const t = makeF5App({ allowedOrigins: ['http://127.0.0.1:5174'] });
    expect((await t.req('GET', '/settings', { headers: { origin: 'http://127.0.0.1:5174' } })).status).toBe(200);
    expect((await t.req('GET', '/settings', { headers: { origin: 'http://127.0.0.1:5175' } })).status).toBe(403);
  });
});

async function boot(uiDir?: string) {
  const token = generateToken();
  const store = new SqliteStore({ path: ':memory:' });
  const registry = new AgentRegistry({ store, vault: new MemoryVault() });
  const hub = new EventHub(store);
  const logs: string[] = [];
  const server = await startServer({
    port: 0,
    token,
    store,
    registry,
    hub,
    log: (l) => logs.push(l),
    validateResponses: true,
    routeModules: [createF5ServerRoutes(uiDir ? { uiDir } : {})],
  });
  running.push(server);
  return { token, hub, server, logs, origin: `http://127.0.0.1:${server.port}` };
}

function open(url: string, protocols: string[], headers: Record<string, string>): Promise<{ ws: WebSocket; first: HubMessage }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers });
    sockets.push(ws);
    ws.once('message', (data) => resolve({ ws, first: JSON.parse(String(data)) as HubMessage }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode ?? 0}`)));
    ws.once('error', reject);
  });
}

describe('WebSocket desde el navegador', () => {
  it('acepta el token como subprotocolo «orq, orq.bearer.<token>» y responde «orq»', async () => {
    const b = await boot();
    const { ws, first } = await open(b.server.wsUrl, ['orq', `orq.bearer.${b.token}`], { origin: b.origin });
    expect(ws.protocol).toBe('orq');
    expect(first).toMatchObject({ type: 'hello' });
    const settings = new Promise<HubMessage>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)) as HubMessage)));
    b.hub.publish({ type: 'settings', settings: { mind: { agentId: null, effort: 'high' }, workers: [], defaultMode: 'plan', quotaFloor: 0.2, concurrency: 3, mindLimits: { turnUsd: 5, dayUsd: 50, maxAutonomousTurns: 5 }, appearance: { theme: 'dark', reducedEffects: false } } });
    expect((await settings).type).toBe('settings');
    // El token nunca va a los registros.
    expect(b.logs.join('\n')).not.toContain(b.token);
  });

  it('sin token, con token incorrecto, sin «orq» delante o con un origen ajeno: rechazado', async () => {
    const b = await boot();
    const wrong = `${b.token.slice(0, -2)}xx`;
    const cases: [string[], Record<string, string>, string][] = [
      [['orq'], { origin: b.origin }, 'HTTP 401'],
      [['orq', `orq.bearer.${wrong}`], { origin: b.origin }, 'HTTP 401'],
      [[`orq.bearer.${b.token}`], { origin: b.origin }, 'HTTP 401'],
      [[`orq.bearer.${b.token}`, 'orq'], { origin: b.origin }, 'HTTP 401'],
      [['orq', `orq.bearer.${b.token}`], { origin: 'https://evil.example' }, 'HTTP 403'],
      [['otro'], { authorization: `Bearer ${b.token}` }, 'HTTP 400'],
    ];
    for (const [protocols, headers, expected] of cases) {
      await expect(open(b.server.wsUrl, protocols, headers), protocols.join(',')).rejects.toThrow(expected);
    }
    // Con Authorization (Node, Electron, Postman) sigue funcionando sin subprotocolo.
    const { ws } = await open(b.server.wsUrl, [], { authorization: `Bearer ${b.token}` });
    expect(ws.protocol).toBe('');
    expect(b.logs.join('\n')).not.toContain(b.token);
  });

  it('el token del subprotocolo solo vale en el handshake del WebSocket, no en REST', async () => {
    const b = await boot();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: b.server.port, path: '/settings', method: 'GET', headers: { 'sec-websocket-protocol': `orq, orq.bearer.${b.token}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);
    expect(protocolToken(`orq, orq.bearer.${b.token}`)).toBe(b.token);
    expect(protocolToken(`orq, orq.bearer.a, orq.bearer.b`)).toBeUndefined();
    expect(protocolToken(undefined)).toBeUndefined();
  });

  it('servidor real: la interfaz se sirve sin token en 127.0.0.1', async () => {
    const b = await boot(await uiFixture());
    const res = await fetch(`${b.origin}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
    expect((await fetch(`${b.origin}/settings`)).status).toBe(401);
  });
});
