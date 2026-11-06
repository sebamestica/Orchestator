/**
 * Fuente de la documentación: las rutas reales del servidor (`createApp(...).routes`, src/core/server).
 *
 * Crea la app sobre una composición en memoria (SQLite `:memory:`, bóveda en memoria, token aleatorio y una carpeta de
 * datos temporal que se borra al cerrar): no escucha en ningún puerto ni toca datos del usuario.
 *
 * Registra los mismos módulos de rutas que `routeModulesFor` (src/core/app/route-modules.ts), armados para que ninguno
 * salga del proceso: c14 (`createF5ServerRoutes`, con un diálogo de carpetas falso que responde `null` y sin interfaz
 * estática), c15 (chats y adjuntos, con los ajustes por defecto), c16 (plugins, sin lanzador de Chrome, sin red para
 * Canva y con candados y perfil de Chrome en la carpeta temporal), c29-uso y c34-almacenamiento. Que la lista no se
 * quede atrás lo comprueba `tests/docs/api-cobertura.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { chatRouteModule } from '../../src/core/app/f5-chat.ts';
import { createF5ServerRoutes } from '../../src/core/app/f5-servidor.ts';
import type { ChatService } from '../../src/core/chat/index.ts';
import { DEFAULT_PORT } from '../../src/core/config/index.ts';
import { LockManager } from '../../src/core/locks/index.ts';
import { PluginService, registerPluginRoutes } from '../../src/core/plugins/index.ts';
import { AgentRegistry } from '../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, loopbackHosts, type CoreApp, type RouteModule, type RouteSpec } from '../../src/core/server/index.ts';
import { createStorageRoutes } from '../../src/core/storage-stats/index.ts';
import { SqliteStore } from '../../src/core/store/index.ts';
import { createUsageRoutes } from '../../src/core/usage-stats/index.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/index.ts';

export interface InMemoryApp {
  core: CoreApp;
  token: string;
  /** Valor del encabezado Host que acepta la app. */
  host: string;
  close(): void;
}

/** Ruta del servidor; `public` si no exige el token (`allowWithoutToken`). */
export type ServerRoute = RouteSpec & { public?: true };

/** Plugins sin efectos fuera del proceso: el lanzador de Chrome no existe y Canva no tiene red. */
function offlinePlugins(store: SqliteStore, vault: MemoryVault, dir: string): PluginService {
  return new PluginService({
    db: store.database,
    vault,
    locks: new LockManager({ root: join(dir, 'candados') }),
    chrome: { toolsDir: join(dir, 'herramientas'), userDataDir: join(dir, 'chrome') },
    canva: { fetch: () => Promise.reject(new Error('La app de la documentación no tiene red')) },
  });
}

/** App real con dependencias en memoria. Sin fábrica de adaptadores ni planificador: esas rutas dan 501. */
export function createInMemoryApp(opts: { validateResponses?: boolean } = {}): InMemoryApp {
  const dir = mkdtempSync(join(tmpdir(), 'orq-docs-'));
  const vault = new MemoryVault();
  let store: SqliteStore | undefined;
  let comp: Composition | undefined;
  let chats: ChatService | undefined;
  const close = () => {
    chats?.shutdown();
    comp?.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    store = new SqliteStore({ path: ':memory:' });
    // Datos en una subcarpeta: las conversaciones van junto a ella (`conversationsRoot`), así también quedan en `dir`.
    comp = compose({
      store,
      vault,
      env: { ORQ_DATA_DIR: join(dir, 'datos') },
      memoryDir: join(dir, 'memoria'),
      skillsHubDir: join(dir, 'hub'),
      projectDir: dir,
      detectors: [],
      hostEnv: () => ({}),
      routeModules: false,
    });
    const token = generateToken();
    const host = loopbackHosts(DEFAULT_PORT)[0] ?? `127.0.0.1:${DEFAULT_PORT}`;
    // Sin fábrica de adaptadores (como antes): `POST /agents` no prueba la clave contra el proveedor.
    const registry = new AgentRegistry({ store, vault, detectors: [] });
    const plugins = offlinePlugins(store, vault, dir);
    const routeModules: RouteModule[] = [
      createF5ServerRoutes({ pickFolder: async () => null }),
      chatRouteModule(comp, { settings: () => DEFAULT_SETTINGS, onReady: (service) => (chats = service) }),
      (ctx) => registerPluginRoutes(ctx, plugins),
      createUsageRoutes(),
      createStorageRoutes({ dataDir: comp.config.dataDir, dbPath: ':memory:' }),
    ];
    const core = createApp({ token, allowedHosts: () => [host], store, registry, hub: new EventHub(store), routeModules, validateResponses: opts.validateResponses ?? false });
    return { core, token, host, close };
  } catch (err) {
    close();
    throw err;
  }
}

/** Tabla de rutas del servidor, en el orden en que `createApp` las registra, con las públicas marcadas. */
export function serverRoutes(): readonly ServerRoute[] {
  const app = createInMemoryApp();
  try {
    const open = new Set(app.core.publicRoutes);
    return app.core.routes.map((r) => (open.has(`${r.method.toUpperCase()} ${r.path}`) ? { ...r, public: true as const } : r));
  } finally {
    app.close();
  }
}
