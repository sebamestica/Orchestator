import type { AgentAdapter, AgentEvent, EventSink, QuotaProvider, Settings, TaskBrief, TaskState } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
import { CONDUCTOR_AGENT_ID, type DelegateResult, type FleetTaskStatus } from '../conductor/index.ts';
import {
  Fleet,
  PlanRegistry,
  Router,
  Supervisor,
  TaskQueue,
  buildReviewTask,
  combinedPlanFor,
  type ExecuteOptions,
  type ExecuteResult,
  type SupervisorOptions,
  type TaskBudgets,
  type TaskStateChange,
  type VerifyWorkspace,
} from '../orchestrator/index.ts';
import type { TaskHooks } from '../server/index.ts';
import type { TaskRecord } from '../store/index.ts';
import type { CommittingWorkspaces } from './commit-step.ts';
import type { Composition } from './compose.ts';
import { FleetRuntime, RETRY_DETAIL, fleetTaskStatus, type SavedTask } from './fleet-port.ts';

export interface FleetTuning {
  /** Tareas simultáneas en la cola (por defecto 3). Con ajustes (`useSettings`) manda `settings.concurrency`. */
  concurrency?: number;
  /**
   * Plazo por inactividad de cada ejecución de un agente: se corta si pasa este tiempo sin eventos (por defecto el
   * del Supervisor: 60 min). Cada evento lo reinicia.
   */
  timeoutMs?: number;
  /** Tope absoluto de cada ejecución aunque el agente siga activo (por defecto el del Supervisor: 3 h). */
  maxRunMs?: number;
  maxRounds?: number;
  /**
   * Tope de gasto por tarea según la dificultad, en USD (por defecto 1 / 3 / 8 para low / medium / high); `null` lo
   * desactiva. Al superarlo la tarea se detiene con `.orq/HANDOFF.md` y el motivo queda en `detail`.
   */
  taskBudgetUsd?: TaskBudgets | null;
  /** Gate del proyecto antes de revisar (por defecto, `workspaces.verify` si el gestor lo tiene). */
  verify?: VerifyWorkspace;
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

/** Tareas de la base que, al arrancar el núcleo sin tenerlas en la cola, quedaron huérfanas (nadie las va a mover). */
const ORPHAN_STATES: ReadonlySet<TaskState> = new Set(['ready', 'running', 'review', 'handed_off']);
/** Motivo de las tareas huérfanas al arrancar: quedan `failed` y se pueden reintentar. */
export const INTERRUPTED_DETAIL = 'interrumpida al reiniciar el núcleo';
/** Cada cuánto, como mucho, se difunde por `/ws` el avance (hora del último evento) de una tarea. */
export const ACTIVITY_PUBLISH_MS = 15_000;
/** Sesiones de agentes ya enlazadas a su tarea que se recuerdan (después se vuelven a enlazar, sin daño). */
const MAX_LINKED_SESSIONS = 5_000;

/** Quien difunde las tareas por `/ws` (`EventHub`). */
export interface TaskPublisher {
  publishTask(task: TaskRecord): void;
}

/** Por qué no se pudo reintentar una tarea (el servidor lo traduce: `not_found` → 404, `conflict` → 409). */
export class RetryError extends Error {
  override readonly name = 'RetryError';
  readonly code: 'not_found' | 'conflict';
  constructor(code: 'not_found' | 'conflict', message: string) {
    super(message);
    this.code = code;
  }
}

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
  /** Difusión de las tareas por `/ws` (el hub que llega por `attachSink`). */
  #publisher: TaskPublisher | undefined;
  #settings: (() => Settings) | undefined;
  /** Id del encargo de revisión → tarea revisada (los eventos del revisor también son avance de la tarea). */
  readonly #reviewOf = new Map<string, string>();
  /** Sesión de agente → tarea a la que ya se enlazó en el almacén (`null`: no es de una tarea del tablero). */
  readonly #linked = new Map<string, string | null>();
  /** Última difusión del avance de cada tarea (ms). */
  readonly #activityAt = new Map<string, number>();

  constructor(deps: FleetDeps, workspaces: CommittingWorkspaces, tuning: FleetTuning = {}, log: (line: string) => void = () => undefined) {
    this.#deps = deps;
    this.workspaces = workspaces;
    this.#tuning = tuning;
    this.#log = log;
    this.#sink = deps.store;
    this.queue = new TaskQueue({ concurrency: tuning.concurrency ?? 3 });
    this.queue.on((change) => this.#copyChange(change));
  }

  /**
   * Destino de los eventos de los agentes (p. ej. `core.hub` para difundirlos por `/ws`); por defecto SQLite. Si el
   * destino difunde tareas (`publishTask`, como el hub), cada cambio de estado de la cola y el avance de las tareas
   * también llegan a la interfaz.
   */
  attachSink(sink: EventSink & Partial<TaskPublisher>): void {
    this.#sink = sink;
    this.#publisher = typeof sink.publishTask === 'function' ? { publishTask: (task) => sink.publishTask?.(task) } : undefined;
  }

  /**
   * Copia un cambio de la cola a la tarea del almacén: estado, agente, motivo (tachado; un cambio sin motivo lo
   * borra) y un intento más cada vez que la flota la empieza. Después lo difunde.
   *
   * `pending` no significa lo mismo en los dos lados: en la cola es «aprobada, esperando sus dependencias»; en la base,
   * «sin aprobar». Una tarea que la base ya tiene aprobada sigue `ready` (con el motivo «esperando a …»): si volviera a
   * `pending`, el tablero le ofrecería Aprobar otra vez y, tras un reinicio, nadie la recuperaría.
   */
  #copyChange(change: TaskStateChange): void {
    const store = this.#deps.store;
    try {
      if (change.to === 'review') {
        const entry = this.queue.get(change.taskId);
        if (entry) this.#reviewOf.set(buildReviewTask(entry.task, [], '').id, change.taskId);
      }
      const stored = store.getTask(change.taskId);
      if (!stored) return;
      const to = change.to === 'pending' && stored.state !== 'pending' ? 'ready' : change.to;
      const saved = store.setTaskState(change.taskId, to, change.agentId, {
        detail: change.detail ?? null,
        ...(change.from === 'ready' && change.to === 'running' ? { countAttempt: true } : {}),
      });
      this.#publish(saved);
    } catch (err) {
      this.#log(redactSecrets(`flota: no se pudo guardar el estado de ${change.taskId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  #publish(task: TaskRecord): void {
    try {
      this.#publisher?.publishTask(task);
    } catch {
      /* la difusión nunca rompe la flota */
    }
  }

  /**
   * Cada evento de un agente de la flota: la primera vez que aparece su sesión se enlaza a la tarea en el almacén (de
   * ahí sale `lastEventAt`), y el avance se difunde como mucho cada `ACTIVITY_PUBLISH_MS` por tarea.
   */
  #activity(event: AgentEvent, task: TaskBrief): void {
    const store = this.#deps.store;
    try {
      let owner = this.#linked.get(event.sessionId);
      const firstSeen = owner === undefined;
      if (owner === undefined) {
        const candidate = this.#reviewOf.get(task.id) ?? task.id;
        owner = store.getTask(candidate) ? candidate : null;
        if (owner) {
          store.startSession({
            id: event.sessionId,
            agentId: event.agentId,
            taskId: owner,
            ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
          });
        }
        if (this.#linked.size >= MAX_LINKED_SESSIONS) this.#linked.clear();
        this.#linked.set(event.sessionId, owner);
      }
      if (!owner || !this.#publisher) return;
      const now = Date.now();
      const last = this.#activityAt.get(owner);
      if (!firstSeen && last !== undefined && now - last < ACTIVITY_PUBLISH_MS) return;
      this.#activityAt.set(owner, now);
      const record = store.getTask(owner);
      if (record) this.#publish(record);
    } catch (err) {
      this.#log(redactSecrets(`flota: no se pudo anotar el avance de ${task.id}: ${err instanceof Error ? err.message : String(err)}`).slice(0, 300));
    }
  }

  /** Tarea guardada en la forma que necesita `FleetRuntime` (reintento y estado tras un reinicio). */
  #savedTask(taskId: string): SavedTask | undefined {
    const t = this.#deps.store.getTask(taskId);
    return t && { task: t.task, state: t.state, agentId: t.agentId, detail: t.detail, attempts: t.attempts, updatedAt: t.updatedAt };
  }

  /** Estado para la mente sin armar la flota: la cola, o la base si la tarea ya terminó o falló (con su motivo). */
  status(taskId: string): FleetTaskStatus | undefined {
    return fleetTaskStatus(this.queue.get(taskId), this.#savedTask(taskId));
  }

  /**
   * Reintenta una tarea fallida (botón «Reintentar», `POST /tasks/:id/retry` y `delegar` de la mente): la cola la
   * vuelve a `ready`, o la reencola desde la base si el núcleo se reinició. Lanza `RetryError` si no existe o no está
   * `failed`, o si la flota no la acepta.
   */
  async retry(taskId: string, reason: string = RETRY_DETAIL): Promise<TaskRecord | undefined> {
    const record = this.#deps.store.getTask(taskId);
    const entry = this.queue.get(taskId);
    if (!record && !entry) throw new RetryError('not_found', `No existe la tarea ${taskId}`);
    const state = entry?.state ?? record?.state;
    if (state !== 'failed') throw new RetryError('conflict', `La tarea ${taskId} está en estado ${state ?? 'desconocido'}: solo se reintenta una tarea fallida`);
    const result: DelegateResult = await (await this.port()).retry(taskId, reason);
    if (!result.accepted) throw new RetryError('conflict', result.reason);
    return this.#deps.store.getTask(taskId);
  }

  /**
   * Al arrancar el núcleo: las tareas de la base que la cola no tiene y que figuran en curso (`ready`, `running`,
   * `review` o `handed_off`) ya no las mueve nadie. Pasan a `failed` con «interrumpida al reiniciar el núcleo» y
   * quedan reintentables. Si la flota no tiene nada en curso, las sesiones de agentes que quedaron abiertas se cierran
   * como `cancelled` (salvo las de la mente, que cada chat retoma).
   */
  recoverOrphans(): TaskRecord[] {
    const store = this.#deps.store;
    const recovered: TaskRecord[] = [];
    for (const t of store.listTasks()) {
      if (!ORPHAN_STATES.has(t.state) || this.queue.get(t.task.id)) continue;
      try {
        const saved = store.setTaskState(t.task.id, 'failed', undefined, { detail: INTERRUPTED_DETAIL });
        recovered.push(saved);
        this.#publish(saved);
      } catch (err) {
        this.#log(redactSecrets(`flota: no se pudo marcar ${t.task.id} como interrumpida: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (recovered.length) {
      const ids = recovered.map((t) => t.task.id);
      this.#log(`flota: ${ids.length} tarea(s) ${INTERRUPTED_DETAIL}, ahora fallidas y reintentables: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? '…' : ''}`);
    }
    const busy = this.queue.list().some((e) => LIVE_STATES.has(e.state)) || (this.#built?.fleet.inFlight().length ?? 0) > 0;
    if (!busy) {
      try {
        const closed = store.cancelOpenSessions({ exceptAgents: [CONDUCTOR_AGENT_ID] });
        if (closed) this.#log(`flota: ${closed} sesión(es) de agentes abiertas al reiniciar quedan canceladas`);
      } catch (err) {
        this.#log(redactSecrets(`flota: no se pudieron cerrar las sesiones abiertas: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    return recovered;
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
        // Un rechazo de la flota (dependencia sin aprobar, ya en la cola, flota deteniéndose) es un conflicto: 409.
        if (!result.accepted) throw Object.assign(new Error(result.reason), { code: 'conflict' });
      },
      onCancel: async (record, reason) => {
        if (!this.#runtime) return true;
        const { fleet } = await this.#runtime;
        // Una tarea que la cola no conoce (p. ej. pendiente, sin aprobar) no tiene nada que detener.
        if (!this.queue.get(record.task.id)) return true;
        // false: ya terminó o pasó el punto de compromiso de la integración (la flota la cancela solo si falla).
        return fleet.cancel(record.task.id, reason ?? 'cancelada por el usuario');
      },
      onRetry: async (record) => {
        await this.retry(record.task.id, 'reintento pedido por el usuario');
      },
      recover: () => {
        this.recoverOrphans();
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
      {
        adapters,
        router,
        sink: { append: (e: AgentEvent) => this.#sink.append(e) },
        queue: this.queue,
        env: d.envFor,
        onEvent: (event, task) => this.#activity(event, task),
        ...(this.#tuning.timeoutMs ? { timeoutMs: this.#tuning.timeoutMs } : {}),
        ...(this.#tuning.maxRunMs ? { maxRunMs: this.#tuning.maxRunMs } : {}),
      },
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
      agentEnv: (workspace) => workspaces.agentEnv(workspace),
      warn: this.#log,
      ...(this.#tuning.timeoutMs ? { timeoutMs: this.#tuning.timeoutMs } : {}),
      ...(this.#tuning.maxRounds ? { maxRounds: this.#tuning.maxRounds } : {}),
      ...(this.#tuning.taskBudgetUsd !== undefined ? { taskBudgetUsd: this.#tuning.taskBudgetUsd } : {}),
      ...(this.#tuning.verify ? { verify: this.#tuning.verify } : {}),
    });
    this.#built = { fleet };
    return { fleet, router, port: new FleetRuntime({ queue: this.queue, fleet, log: this.#log, saved: (id) => this.#savedTask(id) }) };
  }
}
