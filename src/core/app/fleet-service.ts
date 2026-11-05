import type { AgentAdapter, AgentEvent, EventSink, QuotaProvider, Settings, TaskBrief } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
import { Fleet, PlanRegistry, Router, Supervisor, TaskQueue, combinedPlanFor, type ExecuteOptions, type ExecuteResult, type SupervisorOptions } from '../orchestrator/index.ts';
import type { TaskHooks } from '../server/index.ts';
import type { CommittingWorkspaces } from './commit-step.ts';
import type { Composition } from './compose.ts';
import { FleetRuntime } from './fleet-port.ts';

export interface FleetTuning {
  /** Tareas simultáneas en la cola (por defecto 3). Con ajustes (`useSettings`) manda `settings.concurrency`. */
  concurrency?: number;
  /** Plazo por ejecución de un agente (por defecto el del Supervisor: 60 min). */
  timeoutMs?: number;
  maxRounds?: number;
  /** Cada ejecución (autor o revisor) al terminar: pruebas, tablas de consumo. */
  onExecuted?: (task: TaskBrief, opts: ExecuteOptions, result: ExecuteResult) => void;
}

/** `Supervisor` que avisa de cada ejecución terminada (no cambia su comportamiento). */
class ObservedSupervisor extends Supervisor {
  readonly #onExecuted: FleetTuning['onExecuted'];
  constructor(opts: SupervisorOptions, onExecuted: FleetTuning['onExecuted']) {
    super(opts);
    this.#onExecuted = onExecuted;
  }
  override async execute(task: TaskBrief, opts: ExecuteOptions): Promise<ExecuteResult> {
    const result = await super.execute(task, opts);
    try {
      this.#onExecuted?.(task, opts, result);
    } catch {
      /* el observador nunca rompe la flota */
    }
    return result;
  }
}

type FleetDeps = Pick<Composition, 'loadAdapters' | 'registry' | 'quotaProviderFactory' | 'store' | 'envFor' | 'memory'> & { plans?: PlanRegistry };

/** Estados de la cola con trabajo en curso o por empezar. */
const LIVE_STATES: ReadonlySet<string> = new Set(['ready', 'running', 'review', 'handed_off']);

/**
 * La flota real de c2 armada con las piezas de la composición: adaptadores con su clave cargada, `Router` con los
 * cupos, `Supervisor` con `envFor`, worktrees de c3 con el paso de commit y la memoria. Se arma al primer uso (carga
 * los adaptadores) y la comparten el servidor (`TaskHooks`) y el orquestador (`FleetPort`). Los cambios de estado de
 * la cola se copian a las tareas del almacén.
 */
export class FleetService {
  readonly queue: TaskQueue;
  readonly workspaces: CommittingWorkspaces;
  readonly #deps: FleetDeps;
  readonly #tuning: FleetTuning;
  readonly #log: (line: string) => void;
  #runtime: Promise<{ fleet: Fleet; port: FleetRuntime; router: Router }> | undefined;
  /** La flota ya armada (para consultas síncronas). */
  #built: { fleet: Fleet } | undefined;
  #sink: EventSink;
  #settings: (() => Settings) | undefined;

  constructor(deps: FleetDeps, workspaces: CommittingWorkspaces, tuning: FleetTuning = {}, log: (line: string) => void = () => undefined) {
    this.#deps = deps;
    this.workspaces = workspaces;
    this.#tuning = tuning;
    this.#log = log;
    this.#sink = deps.store;
    this.queue = new TaskQueue({ concurrency: tuning.concurrency ?? 3 });
    this.queue.on((change) => {
      try {
        if (deps.store.getTask(change.taskId)) deps.store.setTaskState(change.taskId, change.to, change.agentId);
      } catch (err) {
        log(redactSecrets(`flota: no se pudo guardar el estado de ${change.taskId}: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /** Destino de los eventos de los agentes (p. ej. `core.hub` para difundirlos por `/ws`); por defecto SQLite. */
  attachSink(sink: EventSink): void {
    this.#sink = sink;
  }

  /**
   * Ajustes de la interfaz (F5): la concurrencia de la cola sale de `settings.concurrency` desde ya, y el router lee
   * `workers` y `quotaFloor` en cada decisión. Es una función para no atar la flota a SQLite.
   */
  useSettings(settings: () => Settings): void {
    this.#settings = settings;
    this.settingsChanged();
  }

  /**
   * Vuelve a leer los ajustes (tras `PATCH /settings`). Si la concurrencia sube, la flota toma más tareas en cuanto
   * termina alguna de las que tiene en curso; si baja, las que ya corren siguen hasta terminar.
   */
  settingsChanged(): void {
    const settings = this.#readSettings();
    if (!settings) return;
    try {
      this.queue.concurrency = settings.concurrency;
    } catch (err) {
      this.#log(redactSecrets(`flota: concurrencia de los ajustes no válida: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  #readSettings(): Settings | undefined {
    try {
      return this.#settings?.();
    } catch (err) {
      this.#log(redactSecrets(`flota: no se pudieron leer los ajustes: ${err instanceof Error ? err.message : String(err)}`));
      return undefined;
    }
  }

  /** Arma la flota (una sola vez). Agentes agregados después requieren `reset()`. */
  runtime(): Promise<{ fleet: Fleet; port: FleetRuntime; router: Router }> {
    this.#runtime ??= this.#build().catch((err: unknown) => {
      this.#runtime = undefined;
      throw err;
    });
    return this.#runtime;
  }

  /** `FleetPort` para el orquestador (c11). */
  async port(): Promise<FleetRuntime> {
    return (await this.runtime()).port;
  }

  /**
   * Ganchos del servidor: aprobar encola en la flota y la arranca; cancelar detiene la tarea. El agente fijado al
   * aprobar (`POST /tasks/:id/approve { agentId }`) pasa a la flota como agente sugerido (el router sigue aplicando
   * cupo, ocupación y la regla de dificultad alta → Claude).
   */
  hooks(): TaskHooks {
    return {
      onApproved: async (record) => {
        const task = record.agentId ? { ...record.task, suggestedAgent: record.agentId } : record.task;
        const result = await (await this.port()).delegate(task);
        if (!result.accepted) throw new Error(result.reason);
      },
      onCancel: async (record, reason) => {
        if (!this.#runtime) return true;
        const { fleet } = await this.#runtime;
        // Una tarea que la cola no conoce (p. ej. pendiente, sin aprobar) no tiene nada que detener.
        if (!this.queue.get(record.task.id)) return true;
        // false: ya terminó o pasó el punto de compromiso de la integración (la flota la cancela solo si falla).
        return fleet.cancel(record.task.id, reason ?? 'cancelada por el usuario');
      },
      activeTasks: (projectId) => this.activeTasks(projectId),
    };
  }

  /** Tareas del proyecto en curso de verdad: en la cola sin terminar o con su ciclo aún abierto en la flota. */
  activeTasks(projectId: string): string[] {
    const ofProject = new Set(this.queue.list().filter((e) => e.task.projectId === projectId).map((e) => e.task.id));
    const live = this.queue.list().filter((e) => e.task.projectId === projectId && LIVE_STATES.has(e.state)).map((e) => e.task.id);
    const inFlight = this.#built ? this.#built.fleet.inFlight().filter((id) => ofProject.has(id)) : [];
    return [...new Set([...live, ...inFlight])];
  }

  async stop(): Promise<void> {
    if (!this.#runtime) return;
    await (await this.#runtime).port.stop();
  }

  async #build(): Promise<{ fleet: Fleet; port: FleetRuntime; router: Router }> {
    const d = this.#deps;
    const adapters: AgentAdapter[] = await d.loadAdapters();
    const quotas: QuotaProvider[] = [];
    for (const agent of d.registry.list().filter((a) => a.config.enabled)) {
      const provider = await d.quotaProviderFactory(agent, await d.registry.secretsFor(agent.config));
      if (provider) quotas.push(provider);
    }
    const router = new Router({ agents: adapters.map((a) => a.config), quotas, settings: () => this.#readSettings() });
    const supervisor = new ObservedSupervisor(
      { adapters, router, sink: { append: (e: AgentEvent) => this.#sink.append(e) }, queue: this.queue, env: d.envFor, ...(this.#tuning.timeoutMs ? { timeoutMs: this.#tuning.timeoutMs } : {}) },
      this.#tuning.onExecuted,
    );
    const workspaces = this.workspaces;
    const fleet = new Fleet({
      queue: this.queue,
      router,
      supervisor,
      workspaces,
      memory: d.memory,
      // Plan general de cada tarea (.orq/PLAN.md): el de `POST /plans` o el de `crear_tareas` de la mente (c17).
      planFor: combinedPlanFor(d.store, d.plans ?? new PlanRegistry()),
      diffSummary: (workspace, _task, run) => workspaces.reviewSummary(workspace, run),
      // Modo local: una tarea a la vez por carpeta y encargo sin commits ni ramas.
      exclusiveKey: (projectId) => workspaces.exclusiveKey(projectId),
      isLocal: (workspace) => workspaces.isLocal(workspace),
      warn: this.#log,
      ...(this.#tuning.timeoutMs ? { timeoutMs: this.#tuning.timeoutMs } : {}),
      ...(this.#tuning.maxRounds ? { maxRounds: this.#tuning.maxRounds } : {}),
    });
    this.#built = { fleet };
    return { fleet, router, port: new FleetRuntime({ queue: this.queue, fleet, log: this.#log }) };
  }
}
