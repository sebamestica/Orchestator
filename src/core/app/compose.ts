import { z } from 'zod';
import type { AgentAdapter, WorkspaceManager } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
import { loadCoreConfig, type CoreConfig } from '../config/index.ts';
import { CONDUCTOR_AGENT_ID } from '../conductor/index.ts';
import { defaultVault, type CoreDeps } from '../main.ts';
import { ObsidianMemory } from '../memory/index.ts';
import { PluginService } from '../plugins/index.ts';
import { PlanRegistry, type PlannerLlm } from '../orchestrator/index.ts';
import { LiveSpend } from '../quota/live-spend.ts';
import { AgentRegistry, defaultCliDetectors, type AdapterFactory, type CliDetector, type QuotaProviderFactory } from '../registry/index.ts';
import type { Planner, RouteModule, TaskHooks } from '../server/index.ts';
import { mindAgentId, settingsStoreFor } from '../settings/index.ts';
import { SkillHub } from '../skills/index.ts';
import { SqliteStore } from '../store/index.ts';
import type { SecretVault } from '../vault/index.ts';
import { createAdapterFactory, type AdapterConstructors, type ApiAdapterFactory, type ClaudeTuning } from './adapters.ts';
import type { CommittingWorkspaces } from './commit-step.ts';
import { buildWorkspaces, defaultApiAdapter, skillsReadRoot } from './defaults.ts';
import { AgentEnvironment } from './env.ts';
import { FleetService, type FleetTuning } from './fleet-service.ts';
import { createClaudePlannerLlm, createPlanner, plannerCredentialsFrom, type Effort } from './planner.ts';
import { createQuotaProviderFactory } from './quotas.ts';
import { routeModulesFor } from './route-modules.ts';

/** Variables propias de la composición (las del núcleo, ORQ_DATA_DIR y demás, las lee `loadCoreConfig`). */
const appEnvSchema = z.object({
  /** Bóveda de Obsidian para la memoria (por defecto la del módulo: `C:\dev\orquestador-memoria`). */
  ORQ_MEMORY_DIR: z.string().trim().min(1).optional(),
  /** Carpeta del hub de skills (por defecto `C:\dev\agent-hub`). */
  ORQ_SKILLS_DIR: z.string().trim().min(1).optional(),
  /** Agente que planifica (por defecto el primer Claude con clave). */
  ORQ_PLANNER_AGENT: z.string().trim().min(1).optional(),
});

export interface ComposeOptions {
  /** `false`: sin los módulos de rutas de F5 (pruebas del núcleo base). */
  routeModules?: false;
  /** Entorno para ORQ_* (por defecto `process.env`). Las credenciales nunca se leen de aquí. */
  env?: Readonly<Record<string, string | undefined>>;
  config?: Partial<CoreConfig>;
  /** Registro (solo líneas ya tachadas). */
  log?: (line: string) => void;
  /** Almacén ya abierto (si se pasa, `close()` no lo cierra). */
  store?: SqliteStore;
  /** Por defecto DPAPI en `vault.json` de la carpeta de datos (memoria fuera de Windows). */
  vault?: SecretVault;
  memoryDir?: string;
  skillsHubDir?: string;
  /** Proyecto cuyas `.agents/skills` se listan (por defecto la carpeta actual). */
  projectDir?: string;
  plannerAgentId?: string;
  plannerEffort?: Effort;
  /** `fetch` para el `probe` de Claude, el planificador y OpenRouter (pruebas o proxy). */
  anthropicFetch?: typeof globalThis.fetch;
  claude?: ClaudeTuning;
  constructors?: Partial<AdapterConstructors>;
  /** Entorno anfitrión de los procesos de los agentes (por defecto `process.env`, sin credenciales de Anthropic). */
  hostEnv?: () => Readonly<Record<string, string | undefined>>;
  detectors?: readonly CliDetector[];
  /** Adaptador de `kind: 'api'` (por defecto `ApiChatAdapter` de c6 con la clave de la bóveda). */
  api?: ApiAdapterFactory;
  /** Ganchos de la cola del servidor (por defecto los de la flota real: aprobar encola, cancelar detiene). */
  tasks?: TaskHooks;
  /** Gestor de worktrees ya armado (por defecto `WorktreeManager` de c3 por proyecto, con el paso de commit). */
  workspaces?: WorkspaceManager;
  /** Configuración de c3 por proyecto (`gate`, `links`, `worktreesRoot`…); los demás salen de `POST /projects`. */
  workspaceProjects?: readonly unknown[];
  fleet?: FleetTuning;
  /** Solo pruebas. */
  token?: string;
  validateResponses?: boolean;
}

export interface Composition {
  config: CoreConfig;
  store: SqliteStore;
  vault: SecretVault;
  /** Registro sobre el mismo almacén y la misma bóveda que usa el servidor. */
  registry: AgentRegistry;
  /** Claves en memoria; `envFor` es la opción `env` de `Supervisor`. */
  env: AgentEnvironment;
  envFor: (agentId: string) => Readonly<Record<string, string>>;
  adapterFactory: AdapterFactory;
  quotaProviderFactory: QuotaProviderFactory;
  plannerLlm: PlannerLlm;
  planner: Planner;
  /** También es el `ConductorMemoryPort` de c11. */
  memory: ObsidianMemory;
  /** También es el `SkillCatalogPort` de c11 (`list()`). */
  skills: SkillHub;
  /** Worktrees de c3 con el paso de commit (ownedPaths + commit antes de revisar e integrar). */
  workspaces: CommittingWorkspaces;
  /** Flota real de c2, compartida por el servidor (`deps.tasks`) y el orquestador. */
  fleet: FleetService;
  /** Entorno anfitrión de los procesos (las credenciales se quitan al usarlo). */
  hostEnv: () => Readonly<Record<string, string | undefined>>;
  /** Plugins de F5 (Chrome, Canva): la misma instancia la usan las rutas, la flota y la mente. */
  plugins: PluginService;
  /** Planes de `crear_tareas` (la mente) para el `.orq/PLAN.md` de cada tarea (c17). */
  plans: PlanRegistry;
  /** Para `startCore(deps)`. */
  deps: CoreDeps;
  /** Gasto registrado en SQLite (USD) con el `agent_id` dado, sin más. */
  spentUsd(agentId: string): number;
  /**
   * Gasto cobrado a la clave del agente (USD): el suyo, el de la mente (`orquestador`) si ese agente es la mente, y lo
   * que llevan sin guardar sus procesos vivos. El tope del adaptador, el cupo manual y el de la mente usan esta suma.
   * `paysMind` lo fija quien sabe con qué agente corre la mente (p. ej. `conversar --agente`).
   */
  billedSpentUsd(agentId: string, paysMind?: boolean): number;
  /** Gasto en curso de los procesos vivos (sesiones de la mente y ejecuciones Claude), por agente que paga. */
  liveSpend: LiveSpend;
  /** Adaptadores listos para `Supervisor`, con su clave ya cargada para `envFor`. */
  loadAdapters(agentIds?: readonly string[]): Promise<AgentAdapter[]>;
  /** Cierra el almacén (sin esperar a la flota). */
  close(): void;
  /** Detiene la flota y cierra. */
  shutdown(): Promise<void>;
}

/**
 * Raíz de composición: configuración → SQLite → bóveda → fábricas (adaptadores, cupos) → planificador, memoria y
 * skills. Produce los `CoreDeps` de `startCore` y las piezas que necesita la orquestación (`envFor`, adaptadores).
 */
export function compose(opts: ComposeOptions = {}): Composition {
  const rawEnv = opts.env ?? process.env;
  const config = loadCoreConfig({ env: rawEnv, overrides: opts.config ?? {} });
  const appEnv = appEnvSchema.parse(Object.fromEntries(Object.keys(appEnvSchema.shape).map((k) => [k, rawEnv[k] || undefined])));
  const log = opts.log ?? (() => undefined);
  const ownsStore = !opts.store;
  const store = opts.store ?? new SqliteStore({ path: config.dbPath, timeZone: config.timeZone });
  try {
    const vault = opts.vault ?? defaultVault(config, log);
    const spentUsd = (agentId: string) => store.spentUsd(agentId);
    const liveSpend = new LiveSpend();
    // `registry` se declara más abajo: solo se llama después, al leer un gasto.
    const isMind = (agentId: string) => mindAgentId(settingsStoreFor(store.database).get(), registry.list().map((a) => a.config)) === agentId;
    const billedSpentUsd = (agentId: string, paysMind = isMind(agentId)) =>
      spentUsd(agentId) + (paysMind ? spentUsd(CONDUCTOR_AGENT_ID) : 0) + liveSpend.inFlightUsd(agentId);
    const spentFn = (agentId: string) => () => billedSpentUsd(agentId);
    const skillsHubDir = opts.skillsHubDir ?? appEnv.ORQ_SKILLS_DIR;
    // Los workers Claude leen el hub de skills (las `skillRefs` de los encargos apuntan allí).
    const skillsRoot = skillsReadRoot(skillsHubDir);
    const claude: ClaudeTuning = { ...(skillsRoot ? { readOnlyPaths: [skillsRoot] } : {}), ...opts.claude };
    // Plugins (c16): una sola instancia por núcleo; la flota recibe sus servidores MCP por la fábrica de adaptadores.
    // `registry` se declara más abajo: `agentKind` solo se llama después, al conectar o entregar un plugin.
    const plugins = new PluginService({ db: store.database, vault, agentKind: (id) => registry.get(id)?.config.kind, log });
    const adapterFactory = createAdapterFactory({
      plugins: plugins.source(),
      spentUsd: spentFn,
      liveSpend: (agentId) => liveSpend.open(agentId),
      ...(opts.hostEnv ? { hostEnv: opts.hostEnv } : {}),
      ...(opts.anthropicFetch ? { fetch: opts.anthropicFetch } : {}),
      claude,
      api: opts.api ?? defaultApiAdapter(opts.anthropicFetch),
      ...(opts.constructors ? { constructors: opts.constructors } : {}),
    });
    const quotaProviderFactory = createQuotaProviderFactory({ spentUsd: spentFn, ...(opts.anthropicFetch ? { fetch: opts.anthropicFetch } : {}) });
    const detectors = opts.detectors ?? defaultCliDetectors();
    const registry = new AgentRegistry({ store, vault, adapterFactory, detectors });
    const env = new AgentEnvironment({ agents: store, vault });
    const plannerAgentId = opts.plannerAgentId ?? appEnv.ORQ_PLANNER_AGENT;
    const plannerLlm = createClaudePlannerLlm({
      credentials: plannerCredentialsFrom(store, vault, plannerAgentId),
      sink: store,
      log,
      ...(opts.plannerEffort ? { effort: opts.plannerEffort } : {}),
      ...(opts.anthropicFetch ? { fetch: opts.anthropicFetch } : {}),
    });
    const planner = createPlanner(plannerLlm);
    const memoryDir = opts.memoryDir ?? appEnv.ORQ_MEMORY_DIR;
    const memory = new ObsidianMemory(memoryDir ? { vaultPath: memoryDir } : {});
    const skills = new SkillHub({ ...(skillsHubDir ? { hubDir: skillsHubDir } : {}), ...(opts.projectDir ? { projectDir: opts.projectDir } : {}) });

    const workspaces = buildWorkspaces({
      ...(opts.workspaces ? { workspaces: opts.workspaces } : {}),
      ...(opts.workspaceProjects ? { projects: opts.workspaceProjects } : {}),
      storeProject: (id) => store.getProject(id),
      log,
      secrets: () => env.secretValues(),
    });
    const loadAdapters = async (agentIds?: readonly string[]): Promise<AgentAdapter[]> => {
      const agents = agentIds ? agentIds.map((id) => registry.require(id)) : registry.list().filter((a) => a.config.enabled);
      const adapters: AgentAdapter[] = [];
      for (const agent of agents) {
        const id = agent.config.id;
        try {
          const adapter = await registry.createAdapter(id);
          await env.load(id);
          adapters.push(adapter);
        } catch (err) {
          if (agentIds) throw err;
          log(redactSecrets(`adaptador ${id} no disponible: ${err instanceof Error ? err.message : String(err)}`).slice(0, 300));
        }
      }
      return adapters;
    };
    const plans = new PlanRegistry();
    const fleet = new FleetService({ loadAdapters, registry, quotaProviderFactory, store, envFor: env.envFor, memory, plans }, workspaces, opts.fleet, log);

    // Se llenan al final, cuando la composición ya existe (los módulos la necesitan).
    const routeModules: RouteModule[] = [];
    const deps: CoreDeps = {
      config,
      env: rawEnv,
      store,
      vault,
      adapterFactory,
      quotaProviderFactory,
      detectors,
      planner,
      skills,
      memory,
      log,
      tasks: opts.tasks ?? fleet.hooks(),
      routeModules,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.validateResponses ? { validateResponses: true } : {}),
    };

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      env.forget();
      if (ownsStore) store.close();
    };
    const composition: Composition = {
      config,
      store,
      vault,
      registry,
      env,
      envFor: env.envFor,
      adapterFactory,
      quotaProviderFactory,
      plannerLlm,
      planner,
      memory,
      skills,
      workspaces,
      fleet,
      plugins,
      plans,
      hostEnv: opts.hostEnv ?? (() => process.env),
      deps,
      spentUsd,
      billedSpentUsd,
      liveSpend,
      loadAdapters,
      close,
      async shutdown() {
        await fleet.stop();
        close();
      },
    };
    if (opts.routeModules !== false) routeModules.push(...routeModulesFor(composition));
    return composition;
  } catch (err) {
    if (ownsStore) store.close();
    throw err;
  }
}
