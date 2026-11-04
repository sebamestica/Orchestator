import { describe, expect, it } from 'vitest';
import { bridgeEndpoint, DesktopConfigError, loadDesktopConfig } from '../../apps/desktop/src/lib/config.ts';
import { childEnv, findOnPath, resolveNodePath } from '../../apps/desktop/src/lib/node-path.ts';
import { escapeHtml, statusPageHtml, statusPageUrl } from '../../apps/desktop/src/lib/status-page.ts';
import { DEFAULT_SIZE, MIN_SIZE, parseWindowState, placeWindow, serializeWindowState } from '../../apps/desktop/src/lib/window-state.ts';
import { createHash } from 'node:crypto';

const APP_PATH = 'C:\\dev\\orquestador\\apps\\desktop\\out';
const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\yo\\AppData\\Local' };

describe('loadDesktopConfig', () => {
  it('por defecto: núcleo en 47811, interfaz servida por el núcleo, sin DevTools, datos en %LOCALAPPDATA%', () => {
    const c = loadDesktopConfig({ env: WIN_ENV, platform: 'win32', appPath: APP_PATH });
    expect(c).toMatchObject({
      port: 47811,
      coreOrigin: 'http://127.0.0.1:47811',
      appOrigin: 'http://127.0.0.1:47811',
      startUrl: 'http://127.0.0.1:47811/',
      uiDev: false,
      devTools: false,
      coreToken: undefined,
    });
    expect(c.dataDir).toBe('C:\\Users\\yo\\AppData\\Local\\orquestador');
    expect(c.sessionPath.replaceAll('/', '\\')).toBe('C:\\Users\\yo\\AppData\\Local\\orquestador\\session.json');
    expect(c.userDataDir.replaceAll('/', '\\')).toBe('C:\\Users\\yo\\AppData\\Local\\orquestador\\desktop');
    expect(c.repoRoot.replaceAll('/', '\\')).toMatch(/[\\]dev[\\]orquestador$/);
  });

  it('ORQ_PORT, ORQ_DATA_DIR, ORQ_UI_DEV y ORQ_DEVTOOLS', () => {
    const c = loadDesktopConfig({
      env: { ...WIN_ENV, ORQ_PORT: '47899', ORQ_DATA_DIR: 'C:\\tmp\\orq-prueba', ORQ_UI_DEV: '1', ORQ_DEVTOOLS: '1', ORQ_REPO_ROOT: 'C:\\otro' },
      platform: 'win32',
      appPath: APP_PATH,
    });
    expect(c).toMatchObject({ port: 47899, coreOrigin: 'http://127.0.0.1:47899', appOrigin: 'http://127.0.0.1:5174', startUrl: 'http://127.0.0.1:5174/', uiDev: true, devTools: true, dataDir: 'C:\\tmp\\orq-prueba', repoRoot: 'C:\\otro' });
  });

  it('rechaza puertos y tokens que no sirven', () => {
    for (const ORQ_PORT of ['0', '70000', 'abc', '47811.5']) {
      expect(() => loadDesktopConfig({ env: { ORQ_PORT }, platform: 'win32', appPath: APP_PATH })).toThrow(DesktopConfigError);
    }
    expect(() => loadDesktopConfig({ env: { ORQ_CORE_TOKEN: 'corto' }, platform: 'win32', appPath: APP_PATH })).toThrow(DesktopConfigError);
    expect(loadDesktopConfig({ env: { ORQ_CORE_TOKEN: 'a'.repeat(43) }, platform: 'win32', appPath: APP_PATH }).coreToken).toBe('a'.repeat(43));
  });
});

describe('bridgeEndpoint', () => {
  const core = { origin: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: 't'.repeat(43) };
  it('en producción habla directo con el núcleo (mismo origen)', () => {
    expect(bridgeEndpoint(core, false)).toEqual({ url: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: core.token });
  });
  it('en desarrollo pasa por el proxy /api de Vite', () => {
    expect(bridgeEndpoint(core, true)).toEqual({ url: '/__core', wsUrl: 'ws://127.0.0.1:5174/__core/ws', token: core.token });
  });
});

describe('node.exe y entorno del núcleo', () => {
  const files = new Set(['C:\\Program Files\\nodejs\\node.exe', 'C:\\repo\\node.exe']);
  const exists = (p: string) => files.has(p);

  it('busca node.exe solo en carpetas absolutas del PATH (ignora «.» y relativas)', () => {
    const env = { Path: '.;bin;"C:\\Program Files\\nodejs";C:\\Windows' };
    expect(findOnPath('node.exe', { env, platform: 'win32', exists })).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(findOnPath('node.exe', { env: { PATH: 'C:\\Windows' }, platform: 'win32', exists })).toBeNull();
    expect(findOnPath('node.exe', { env: {}, platform: 'win32', exists })).toBeNull();
  });

  it('ORQ_NODE manda si es una ruta absoluta que existe', () => {
    expect(resolveNodePath({ env: { ORQ_NODE: 'C:\\repo\\node.exe', PATH: 'C:\\Program Files\\nodejs' }, platform: 'win32', exists })).toBe('C:\\repo\\node.exe');
    expect(resolveNodePath({ env: { ORQ_NODE: 'node.exe', PATH: 'C:\\Program Files\\nodejs' }, platform: 'win32', exists })).toBeNull();
    expect(resolveNodePath({ env: { PATH: 'C:\\Program Files\\nodejs' }, platform: 'win32', exists })).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('el hijo no hereda variables de Electron, de la app ni el token; ORQ_PORT y los orígenes van fijos', () => {
    const env = childEnv(
      {
        Path: 'C:\\Windows',
        ELECTRON_RUN_AS_NODE: '1',
        electron_no_attach_console: '1',
        ORQ_UI_DEV: '1',
        ORQ_DEVTOOLS: '1',
        ORQ_CORE_TOKEN: 'a'.repeat(43),
        ORQ_PORT: '1234',
        ORQ_ALLOWED_ORIGINS: 'http://127.0.0.1:9000, http://127.0.0.1:47899',
        ORQ_DATA_DIR: 'C:\\tmp\\x',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        VACIA: undefined,
      },
      { port: 47899, allowedOrigins: ['http://127.0.0.1:47899', 'http://127.0.0.1:5174'] },
    );
    expect(env).toEqual({
      Path: 'C:\\Windows',
      ORQ_DATA_DIR: 'C:\\tmp\\x',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ORQ_PORT: '47899',
      ORQ_ALLOWED_ORIGINS: 'http://127.0.0.1:9000,http://127.0.0.1:47899,http://127.0.0.1:5174',
    });
  });
});

describe('página de estado', () => {
  it('escapa el texto y su CSP solo permite su propio script por hash', () => {
    const html = statusPageHtml({ title: '<img src=x onerror=alert(1)>', detail: '"&\'<script>', hint: 'a > b', busy: true });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;&amp;&#39;&lt;script&gt;');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(html).toContain(`script-src 'sha256-${hash}'`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<title>Berland</title>');
    expect(html).toContain('class="spin"');
  });

  it('se entrega como URL data: decodificable', () => {
    const url = statusPageUrl({ title: 'Arrancando el núcleo…' });
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toContain('Arrancando el núcleo…');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });
});

describe('estado de la ventana', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 1280, height: 984 };

  it('sin estado: tamaño por defecto, centrada', () => {
    expect(placeWindow(null, [primary])).toEqual({ ...DEFAULT_SIZE, maximized: false });
    expect(placeWindow(null, [{ x: 0, y: 0, width: 1024, height: 700 }])).toEqual({ width: 1024, height: 700, maximized: false });
  });

  it('respeta el mínimo de 960×600 y no pasa de la pantalla más grande', () => {
    expect(placeWindow({ bounds: { x: 10, y: 10, width: 300, height: 200 }, maximized: false }, [primary])).toEqual({ ...MIN_SIZE, x: 10, y: 10, maximized: false });
    expect(placeWindow({ bounds: { x: 0, y: 0, width: 5000, height: 4000 }, maximized: true }, [primary, second])).toEqual({ width: 1920, height: 1040, x: 0, y: 0, maximized: true });
  });

  it('conserva la posición en un segundo monitor y la descarta si ese monitor ya no está', () => {
    const saved = { bounds: { x: 2000, y: 50, width: 1100, height: 700 }, maximized: false };
    expect(placeWindow(saved, [primary, second])).toEqual({ width: 1100, height: 700, x: 2000, y: 50, maximized: false });
    expect(placeWindow(saved, [primary])).toEqual({ width: 1100, height: 700, maximized: false });
    // Barra de título fuera de la pantalla (arriba).
    expect(placeWindow({ bounds: { x: 100, y: -900, width: 1100, height: 700 }, maximized: false }, [primary])).toEqual({ width: 1100, height: 700, maximized: false });
  });

  it('lee y escribe el archivo, y descarta lo que no tiene la forma esperada', () => {
    const state = { bounds: { x: 12.4, y: 30.6, width: 1280.2, height: 800 }, maximized: true };
    expect(parseWindowState(serializeWindowState(state))).toEqual({ bounds: { x: 12, y: 31, width: 1280, height: 800 }, maximized: true });
    expect(parseWindowState(null)).toBeNull();
    expect(parseWindowState('{"bounds":{"x":0,"y":0,"width":-5,"height":10},"maximized":false}')).toBeNull();
    expect(parseWindowState('{"bounds":{"x":0,"y":0,"width":1000,"height":700}}')).toBeNull();
    expect(parseWindowState('no json')).toBeNull();
  });
});
