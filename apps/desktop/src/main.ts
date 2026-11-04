import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, safeStorage, screen, session, shell } from 'electron';
import { CoreSupervisor } from './core-supervisor.ts';
import { registerIpc } from './ipc.ts';
import { APP_NAME, bridgeEndpoint, loadDesktopConfig, type DesktopConfig } from './lib/config.ts';
import { allowedExternalUrl, classifyNavigation, isSameOrigin } from './lib/external-url.ts';
import { createFileLog } from './lib/log.ts';
import { resolveNodePath } from './lib/node-path.ts';
import type { Cipher } from './lib/session-file.ts';
import { statusPageUrl, type StatusPage } from './lib/status-page.ts';
import { MIN_SIZE, parseWindowState, placeWindow, serializeWindowState } from './lib/window-state.ts';

const BACKGROUND = '#090909';
/** Permisos que la interfaz puede pedir (copiar y pegar). Todo lo demás se deniega. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);
/** Tope del cierre: si el núcleo no contesta, la ventana se cierra igual y el núcleo sigue. */
const CLOSE_TIMEOUT_MS = 8000;
/** En desarrollo, reintentos mientras arranca `npm run dev:ui`. */
const DEV_RETRIES = 60;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function hardenSession(appOrigin: string): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isSameOrigin(details.requestingUrl, appOrigin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ALLOWED_PERMISSIONS.has(permission) && requestingOrigin === appOrigin);
}

/** Navegación: solo el propio origen; enlaces permitidos al navegador; el resto (archivos soltados incluidos), bloqueado. */
function hardenContents(appOrigin: string, log: (line: string) => void): void {
  app.on('web-contents-created', (_e, contents) => {
    const guard = (event: { preventDefault(): void }, url: string) => {
      const verdict = classifyNavigation(url, appOrigin);
      if (verdict === 'allow') return;
      event.preventDefault();
      const external = verdict === 'external' ? allowedExternalUrl(url) : null;
      if (external) void shell.openExternal(external);
      else log(`navegación bloqueada (${url.slice(0, url.indexOf(':') + 1) || 'sin esquema'})`);
    };
    contents.on('will-navigate', (e) => guard(e, e.url));
    contents.on('will-frame-navigate', (e) => guard(e, e.url));
    contents.on('will-redirect', (e) => guard(e, e.url));
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      const external = allowedExternalUrl(url);
      if (external) void shell.openExternal(external);
      return { action: 'deny' };
    });
  });
}

function createWindow(config: DesktopConfig, preload: string, icon: string): { win: BrowserWindow; saveState(): void } {
  const statePath = join(config.userDataDir, 'window-state.json');
  const placement = placeWindow(
    parseWindowState(readText(statePath)),
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BrowserWindow({
    width: placement.width,
    height: placement.height,
    ...(placement.x !== undefined && placement.y !== undefined ? { x: placement.x, y: placement.y } : {}),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    backgroundColor: BACKGROUND,
    title: APP_NAME,
    show: false,
    ...(existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      backgroundThrottling: true,
      devTools: config.devTools,
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    if (placement.maximized) win.maximize();
    win.show();
  });

  let timer: NodeJS.Timeout | undefined;
  const saveState = () => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    try {
      mkdirSync(config.userDataDir, { recursive: true });
      writeFileSync(statePath, serializeWindowState({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {
      // No poder guardar el tamaño no es motivo para fallar.
    }
  };
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(saveState, 600);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('maximize', saveSoon);
  win.on('unmaximize', saveSoon);
  return { win, saveState };
}

async function run(config: DesktopConfig): Promise<void> {
  const secrets: string[] = [];
  const log = createFileLog(join(config.logDir, 'escritorio.log'), () => secrets);
  log(`Berland ${app.getVersion()} (Electron ${process.versions.electron}) · núcleo ${config.coreOrigin} · interfaz ${config.startUrl}`);

  await app.whenReady();
  Menu.setApplicationMenu(null);
  hardenSession(config.appOrigin);
  hardenContents(config.appOrigin, log);

  const cipher: Cipher | null = safeStorage.isEncryptionAvailable()
    ? { encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) }
    : null;
  const supervisor = new CoreSupervisor({
    config,
    env: process.env,
    platform: process.platform,
    cipher,
    fetch,
    nodePath: resolveNodePath({ env: process.env, platform: process.platform, exists: existsSync }),
    log,
  });

  const appPath = app.getAppPath();
  const { win, saveState } = createWindow(config, join(appPath, 'preload.js'), join(appPath, '..', 'assets', 'icon.ico'));
  let statusShown = false;
  let httpFailure = false;
  const showStatus = (page: StatusPage) => {
    if (win.isDestroyed()) return;
    statusShown = true;
    win.loadURL(statusPageUrl(page)).catch(() => undefined);
  };

  registerIpc({
    appOrigin: config.appOrigin,
    window: () => (win.isDestroyed() ? null : win),
    statusPageShown: () => statusShown,
    log,
    endpoint: async () => {
      const core = supervisor.current;
      if (!core) throw new Error('El núcleo no está conectado');
      return bridgeEndpoint(core, config.uiDev);
    },
  });

  app.on('second-instance', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // Cierre: se oculta la ventana enseguida y se aplica la regla del núcleo (ver CoreSupervisor.onAppClose).
  let quitting = false;
  let shuttingDown: Promise<void> | null = null;
  const shutdown = () => {
    shuttingDown ??= (async () => {
      try {
        const d = await Promise.race([
          supervisor.onAppClose(),
          delay(CLOSE_TIMEOUT_MS).then(() => ({ stop: false, reason: 'el cierre tardó demasiado: el núcleo sigue vivo' })),
        ]);
        log(`ventana cerrada: ${d.reason}`);
      } catch (err) {
        log(`error al cerrar: ${message(err)}`);
      }
      quitting = true;
      // Con la CPU ocupada, el desmontaje nativo de Electron puede tardar decenas de segundos tras
      // `quit`. Se suelta ya el candado para que reabrir Berland en ese rato abra una ventana nueva.
      app.releaseSingleInstanceLock();
      app.quit();
    })();
  };
  win.on('close', (e) => {
    saveState();
    if (quitting) return;
    e.preventDefault();
    win.hide();
    shutdown();
  });
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (!win.isDestroyed()) win.hide();
    shutdown();
  });
  app.on('window-all-closed', () => app.quit());

  win.webContents.on('render-process-gone', (_e, details) => {
    log(`la interfaz se cayó (${details.reason})`);
    if (!quitting) showStatus({ title: 'La interfaz se cerró de forma inesperada', detail: details.reason, hint: 'Vuelve a abrir Berland.' });
  });
  win.webContents.on('did-navigate', (_e, url, code) => {
    if (code >= 400 && isSameOrigin(url, config.appOrigin)) {
      httpFailure = true;
      log(`la interfaz respondió HTTP ${code}`);
      showStatus({
        title: 'El núcleo no sirve la interfaz',
        detail: `GET ${new URL(url).pathname} → HTTP ${code}`,
        hint: 'Compila la interfaz con «npm run build:ui» y usa un núcleo que la sirva, o abre Berland con ORQ_UI_DEV=1 y «npm run dev:ui».',
      });
    }
  });
  supervisor.onUnexpectedExit((code) => {
    if (!quitting) showStatus({ title: 'El núcleo se detuvo', detail: `Código de salida: ${code ?? '?'}`, hint: `Vuelve a abrir Berland. Registro: ${supervisor.logPath}` });
  });

  showStatus({ title: 'Arrancando el núcleo…', busy: true });
  const result = await supervisor.connect();
  if (!result.ok) {
    showStatus({ title: result.title, ...(result.detail ? { detail: result.detail } : {}), ...(result.hint ? { hint: result.hint } : {}) });
    return;
  }
  secrets.push(result.core.token);
  if (win.isDestroyed() || quitting) return;

  for (let attempt = 0; ; attempt++) {
    try {
      statusShown = false;
      await win.loadURL(config.startUrl);
      break;
    } catch (err) {
      // Si respondió con un error HTTP, `did-navigate` ya mostró la página de estado (y abortó esta carga).
      if (win.isDestroyed() || quitting || httpFailure) return;
      if (config.uiDev && attempt < DEV_RETRIES) {
        if (attempt === 0) showStatus({ title: 'Esperando a «npm run dev:ui» en 127.0.0.1:5174…', busy: true });
        await delay(1000);
        continue;
      }
      log(`no se pudo cargar la interfaz: ${message(err)}`);
      showStatus({ title: 'No se pudo cargar la interfaz', detail: message(err), hint: config.uiDev ? 'Arranca «npm run dev:ui».' : 'Comprueba que el núcleo sirve la interfaz (dist/ui).' });
      return;
    }
  }
  if (config.devTools) win.webContents.openDevTools({ mode: 'detach' });
}

function main(): void {
  let config: DesktopConfig;
  try {
    config = loadDesktopConfig({ env: process.env, platform: process.platform, appPath: app.getAppPath() });
  } catch (err) {
    dialog.showErrorBox(APP_NAME, message(err));
    app.exit(1);
    return;
  }
  app.setName(APP_NAME);
  // Perfil propio y estable: safeStorage guarda su clave en `Local State` de esta carpeta, y el candado
  // de instancia única va por carpeta (una prueba con otro ORQ_DATA_DIR no choca con la app real).
  app.setPath('userData', config.userDataDir);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  run(config).catch((err: unknown) => {
    dialog.showErrorBox(APP_NAME, `No se pudo abrir Berland: ${message(err)}`);
    app.exit(1);
  });
}

main();
