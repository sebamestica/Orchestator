/**
 * Fuente de la documentación: las rutas reales del servidor (`createApp(...).routes`, src/core/server).
 *
 * Crea la app con dependencias en memoria (SQLite `:memory:`, bóveda en memoria, token aleatorio) solo
 * para leer la tabla de rutas: no escucha en ningún puerto ni toca datos del usuario.
 *
 * Incluye los módulos de rutas de F5 que se pueden armar sin la composición: c14 (`createF5ServerRoutes`, con un
 * diálogo de carpetas falso que responde `null` y sin interfaz estática).
 */
import { createF5ServerRoutes } from '../../src/core/app/f5-servidor.ts';
import { DEFAULT_PORT } from '../../src/core/config/index.ts';
import { AgentRegistry } from '../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, loopbackHosts, type CoreApp, type RouteSpec } from '../../src/core/server/index.ts';
import { SqliteStore } from '../../src/core/store/index.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';

export interface InMemoryApp {
  core: CoreApp;
  token: string;
  /** Valor del encabezado Host que acepta la app. */
  host: string;
  close(): void;
}

/** App real con dependencias en memoria. Sin fábrica de adaptadores ni planificador: esas rutas dan 501. */
export function createInMemoryApp(opts: { validateResponses?: boolean } = {}): InMemoryApp {
  const store = new SqliteStore({ path: ':memory:' });
  try {
    const registry = new AgentRegistry({ store, vault: new MemoryVault(), detectors: [] });
    const hub = new EventHub(store);
    const token = generateToken();
    const host = loopbackHosts(DEFAULT_PORT)[0] ?? `127.0.0.1:${DEFAULT_PORT}`;
    const routeModules = [createF5ServerRoutes({ pickFolder: async () => null })];
    const core = createApp({ token, allowedHosts: () => [host], store, registry, hub, routeModules, validateResponses: opts.validateResponses ?? false });
    return { core, token, host, close: () => store.close() };
  } catch (err) {
    store.close();
    throw err;
  }
}

/** Tabla de rutas del servidor, en el orden en que `createApp` las registra. */
export function serverRoutes(): readonly RouteSpec[] {
  const app = createInMemoryApp();
  try {
    return app.core.routes;
  } finally {
    app.close();
  }
}
