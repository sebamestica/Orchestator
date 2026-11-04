import type { MemoryStore } from '../shared/index.ts';
import { loadCoreConfig, type CoreConfig } from './config/index.ts';
import {
  AgentRegistry,
  QuotaRefresher,
  defaultCliDetectors,
  type AdapterFactory,
  type CliDetector,
  type QuotaProviderFactory,
} from './registry/index.ts';
import {
  EventHub,
  generateToken,
  startServer,
  type Planner,
  type RouteModule,
  type RunningServer,
  type SkillsService,
  type TaskHooks,
} from './server/index.ts';
import { SqliteStore, type QuotaRecord } from './store/index.ts';
import { FileVault, MemoryVault, createDpapiCipher, type SecretVault } from './vault/index.ts';

/**
 * Dependencias del arranque. Los módulos de otros agentes (adaptadores, cupos, planificador,
 * skills, memoria, orquestación) se inyectan aquí; si faltan, sus rutas responden 501.
 */
export interface CoreDeps {
  /** Reemplaza valores de la configuración (por encima de las variables ORQ_*). */
  config?: Partial<CoreConfig>;
  env?: Readonly<Record<string, string | undefined>>;
  /** Almacén ya abierto (si se pasa, `stop()` no lo cierra). */
  store?: SqliteStore;
  vault?: SecretVault;
  adapterFactory?: AdapterFactory;
  quotaProviderFactory?: QuotaProviderFactory;
  detectors?: readonly CliDetector[];
  planner?: Planner;
  skills?: SkillsService;
  memory?: MemoryStore;
  tasks?: TaskHooks;
  /** Módulos de rutas de F5 (ajustes, chats, plugins…). */
  routeModules?: readonly RouteModule[];
  /** Registro (líneas ya tachadas, sin encabezados ni cuerpos). */
  log?: (line: string) => void;
  /** Solo pruebas: token fijo. En producción se genera uno por arranque. */
  token?: string;
  validateResponses?: boolean;
}

export interface Core {
  config: CoreConfig;
  store: SqliteStore;
  vault: SecretVault;
  registry: AgentRegistry;
  /** `EventSink` para la orquestación: guarda y transmite por `/ws`. */
  hub: EventHub;
  quotas: QuotaRefresher<QuotaRecord> | undefined;
  server: RunningServer;
  url: string;
  token: string;
  stop(): Promise<void>;
}

/** Bóveda por defecto: DPAPI en `%LOCALAPPDATA%\orquestador\vault.json`; en memoria fuera de Windows (desarrollo). */
export function defaultVault(config: CoreConfig, log: (line: string) => void, platform: NodeJS.Platform = process.platform): SecretVault {
  if (platform === 'win32') {
    return new FileVault({ path: config.vaultPath, cipher: createDpapiCipher({ powershellPath: config.powershellPath }), log });
  }
  log('bóveda en memoria: DPAPI solo existe en Windows; las claves no se guardarán');
  return new MemoryVault();
}

/** Arranca el núcleo: configuración → SQLite → bóveda → registro → hub → servidor en 127.0.0.1. */
export async function startCore(deps: CoreDeps = {}): Promise<Core> {
  const config = loadCoreConfig({ ...(deps.env ? { env: deps.env } : {}), overrides: deps.config ?? {} });
  const log = deps.log ?? (() => undefined);
  const ownsStore = !deps.store;
  const store = deps.store ?? new SqliteStore({ path: config.dbPath, timeZone: config.timeZone });
  try {
    const vault = deps.vault ?? defaultVault(config, log);
    const registry = new AgentRegistry({
      store,
      vault,
      ...(deps.adapterFactory ? { adapterFactory: deps.adapterFactory } : {}),
      detectors: deps.detectors ?? defaultCliDetectors(),
    });
    const hub = new EventHub(store, { onListenerError: () => log('ws: error al enviar a un cliente') });
    const quotas = deps.quotaProviderFactory
      ? new QuotaRefresher<QuotaRecord>({ registry, factory: deps.quotaProviderFactory, publish: (s) => hub.publishQuota(s) })
      : undefined;
    const token = deps.token ?? generateToken();
    const server = await startServer({
      port: config.port,
      token,
      allowedOrigins: config.allowedOrigins,
      store,
      registry,
      hub,
      log,
      ...(quotas ? { quotas } : {}),
      ...(deps.planner ? { planner: deps.planner } : {}),
      ...(deps.skills ? { skills: deps.skills } : {}),
      ...(deps.memory ? { memory: deps.memory } : {}),
      ...(deps.tasks ? { tasks: deps.tasks } : {}),
      ...(deps.routeModules ? { routeModules: deps.routeModules } : {}),
      ...(deps.validateResponses ? { validateResponses: true } : {}),
    });
    const timer =
      quotas && config.quotaRefreshMs > 0
        ? setInterval(() => {
            quotas.refresh().then(
              (r) => { for (const e of r.errors) log(`cupo ${e.agentId}: ${e.message}`); },
              () => log('cupo: falló la lectura periódica'),
            );
          }, config.quotaRefreshMs)
        : undefined;
    timer?.unref();
    let stopped: Promise<void> | undefined;
    return {
      config,
      store,
      vault,
      registry,
      hub,
      quotas,
      server,
      url: server.url,
      token,
      stop() {
        stopped ??= (async () => {
          if (timer) clearInterval(timer);
          await server.close();
          if (ownsStore) store.close();
        })();
        return stopped;
      },
    };
  } catch (err) {
    if (ownsStore) store.close();
    throw err;
  }
}

// `node src/core/main.ts`: arranca con la configuración del entorno y anuncia URL y token en una
// sola línea JSON por stdout (la lee Electron; para Postman, copia `token` a la variable `token`).
if (import.meta.main) {
  const core = await startCore({ log: (line) => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${JSON.stringify({ ready: true, url: core.url, wsUrl: core.server.wsUrl, token: core.token })}\n`);
  const shutdown = () => {
    void core.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
