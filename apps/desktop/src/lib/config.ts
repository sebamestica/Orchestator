import { join, resolve } from 'node:path';
import { DEFAULT_PORT, defaultDataDir } from '../../../../src/core/config/config.ts';

/** Nombre visible de la app (ventana, acceso directo, diálogos). Los nombres internos siguen siendo «orquestador». */
export const APP_NAME = 'Berland';
export const LOOPBACK = '127.0.0.1';
/** Servidor de `npm run dev:ui` (fijo en `src/ui/vite.config.ts`). */
export const UI_DEV_ORIGIN = `http://${LOOPBACK}:5174`;
export const DEFAULT_READY_TIMEOUT_MS = 45_000;

export interface DesktopConfig {
  /** Puerto del núcleo (`ORQ_PORT`, 47811 por defecto). */
  port: number;
  /** `http://127.0.0.1:<puerto>`. */
  coreOrigin: string;
  /** `ORQ_UI_DEV=1`: la ventana carga el servidor de Vite (5174) en vez de la interfaz del núcleo. */
  uiDev: boolean;
  /** Único origen al que navega la ventana y del que se aceptan mensajes IPC. */
  appOrigin: string;
  startUrl: string;
  /** `ORQ_DEVTOOLS=1`. En producción no hay DevTools. */
  devTools: boolean;
  /** Carpeta de datos del núcleo (`ORQ_DATA_DIR` o `%LOCALAPPDATA%\orquestador`). */
  dataDir: string;
  /** Perfil de Electron (caché, `Local State` con la clave de safeStorage, estado de la ventana). */
  userDataDir: string;
  /** Sesión del núcleo lanzado por la app, con el token cifrado. */
  sessionPath: string;
  logDir: string;
  /** Raíz del repo (`ORQ_REPO_ROOT` o tres niveles sobre `apps/desktop/out`). */
  repoRoot: string;
  /** `ORQ_CORE_TOKEN`: token de un núcleo abierto a mano (solo en memoria; ese núcleo nunca se apaga). */
  coreToken: string | undefined;
  readyTimeoutMs: number;
}

export class DesktopConfigError extends Error {
  override readonly name = 'DesktopConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

function intVar(env: Env, name: string, min: number, max: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new DesktopConfigError(`${name} inválido: debe ser un entero entre ${min} y ${max}`);
  return n;
}

export interface ConfigInput {
  env: Env;
  platform: NodeJS.Platform;
  /** `app.getAppPath()`: la carpeta `apps/desktop/out`. */
  appPath: string;
  home?: string;
}

/** Configuración de la app de escritorio a partir del entorno (mismas variables `ORQ_*` que el núcleo). */
export function loadDesktopConfig(input: ConfigInput): DesktopConfig {
  const { env, platform } = input;
  // El puerto 0 (aleatorio) no sirve: la app tiene que encontrar el núcleo en un puerto fijo.
  const port = intVar(env, 'ORQ_PORT', 1, 65535) ?? DEFAULT_PORT;
  const coreOrigin = `http://${LOOPBACK}:${port}`;
  const uiDev = env.ORQ_UI_DEV?.trim() === '1';
  const appOrigin = uiDev ? UI_DEV_ORIGIN : coreOrigin;
  const dataDir = defaultDataDir({ env, platform, ...(input.home ? { home: input.home } : {}) });
  const token = env.ORQ_CORE_TOKEN?.trim();
  if (token !== undefined && token !== '' && !/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
    throw new DesktopConfigError('ORQ_CORE_TOKEN no tiene la forma de un token del núcleo');
  }
  return {
    port,
    coreOrigin,
    uiDev,
    appOrigin,
    startUrl: `${appOrigin}/`,
    devTools: env.ORQ_DEVTOOLS?.trim() === '1',
    dataDir,
    userDataDir: join(dataDir, 'desktop'),
    sessionPath: join(dataDir, 'session.json'),
    logDir: join(dataDir, 'logs'),
    repoRoot: env.ORQ_REPO_ROOT?.trim() || resolve(input.appPath, '..', '..', '..'),
    coreToken: token || undefined,
    readyTimeoutMs: intVar(env, 'ORQ_CORE_TIMEOUT_MS', 1000, 600_000) ?? DEFAULT_READY_TIMEOUT_MS,
  };
}

/** Lo que `window.orq.core()` entrega a la interfaz. */
export interface BridgeEndpoint {
  url: string;
  wsUrl: string;
  token: string;
}

/**
 * En producción la interfaz vive en el mismo origen que el núcleo y habla con él directo.
 * Con `ORQ_UI_DEV=1` pasa por el proxy `/api` de Vite (mismo origen 5174, sin CORS).
 */
export function bridgeEndpoint(core: { origin: string; wsUrl: string; token: string }, uiDev: boolean): BridgeEndpoint {
  if (uiDev) return { url: '/__core', wsUrl: `${UI_DEV_ORIGIN.replace(/^http/, 'ws')}/__core/ws`, token: core.token };
  return { url: core.origin, wsUrl: core.wsUrl, token: core.token };
}
