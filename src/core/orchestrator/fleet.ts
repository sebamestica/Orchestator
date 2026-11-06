import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Handoff, IntegrationResult, MemoryStore, SessionSummary, TaskBrief, TaskState, Workspace, WorkspaceManager } from '../../shared/index.ts';
import { idSchema, PLAN_FILES, redactSecrets, taskBriefSchema } from '../../shared/index.ts';
import { renderBrief } from '../brief/render-brief.ts';
import { planTitle, renderPlanFile, type GeneralPlan } from '../brief/render-plan.ts';
import type { TaskQueue } from './queue.ts';
import { normalizeOwnedPath } from './paths.ts';
import { RoutingError, type Router } from './router.ts';
import { HANDOFF_FILE, summarizeAttempt, type AttemptResult, type BeforeAttemptInfo, type ExecuteOptions, type ExecuteResult, type Supervisor } from './supervisor.ts';
import {
  clipTaskPlan,
  parseTaskPlan,
  taskPlanDetail,
  taskPlanNote,
  taskPlanProblem,
  withTaskPlanNote,
  type PlanFor,
  type PlanMemory,
  type SessionPlanInfo,
  type TaskPlanStatus,
} from './task-plan.ts';

export const BRIEF_FILE = join('.orq', 'BRIEF.md');
/** Plan general (solo lectura para el agente) y plan de la tarea (lo escribe el agente). */
export const PLAN_FILE = join(...PLAN_FILES.plan.split('/'));
export const TASK_PLAN_FILE = join(...PLAN_FILES.taskPlan.split('/'));
export const DEFAULT_MEMORY_BUDGET_CHARS = 4_000;
/** Rondas autor → revisión → integración por tarea. */
export const DEFAULT_MAX_ROUNDS = 3;
/** Revisores que se prueban si uno no entrega un veredicto válido. */
const REVIEW_TRIES = 2;
const REVIEW_MAX_ATTEMPTS = 2;
/** Resumen del gate que va en el encargo de revisión o en las observaciones al autor. */
const GATE_SUMMARY_MAX = 3_000;

export type Difficulty = TaskBrief['difficulty'];
/** Tope de gasto por tarea en USD según su dificultad (autores y revisores, por ciclo de la tarea). */
export type TaskBudgets = Partial<Record<Difficulty, number>>;
/** Topes por defecto (decisión del usuario, issue 6): 1 / 3 / 8 USD para low / medium / high. */
export const DEFAULT_TASK_BUDGET_USD: Readonly<Record<Difficulty, number>> = { low: 1, medium: 3, high: 8 };

/** Resultado de la verificación del proyecto (gate) corrida en el worktree de la tarea, sin LLM. */
export interface GateCheck {
  ok: boolean;
  summary: string;
}
/**
 * Corre el gate del proyecto en el workspace de la tarea antes de revisar. `undefined`: el proyecto no tiene gate (p.
 * ej. una carpeta local sin verificación) y el revisor la comprueba como antes.
 */
export type VerifyWorkspace = (workspace: Workspace, task: TaskBrief, signal: AbortSignal) => Promise<GateCheck | undefined>;

export const reviewVerdictSchema = z.strictObject({
  veredicto: z.enum(['aprobado', 'rechazado']),
  observaciones: z.array(z.string()).default([]),
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export interface FleetOptions {
  queue: TaskQueue;
  router: Router;
  supervisor: Supervisor;
  workspaces: WorkspaceManager;
  memory: MemoryStore;
  /** Escribe un archivo (creando carpetas). Por defecto, `fs.writeFile` en UTF-8. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Lee un archivo del worktree; `undefined` si no existe. Por defecto, `fs.readFile` en UTF-8. */
  readFile?: (path: string) => Promise<string | undefined>;
  /**
   * Plan general de cada tarea (p. ej. `planFromStore(store)`), que se escribe en `.orq/PLAN.md`. Sin él, o si
   * devuelve `undefined`, la flota escribe un plan mínimo generado del encargo.
   */
  planFor?: PlanFor;
  /** Dónde guardar el plan general en la memoria. Por defecto, `memory` si tiene `recordPlan`; `null` lo desactiva. */
  planMemory?: PlanMemory | null;
  /** Resumen del diff para el revisor. Por defecto: archivos de los eventos `file_change` y resumen del autor. */
  diffSummary?: (workspace: Workspace, task: TaskBrief, run: ExecuteResult) => Promise<string>;
  /**
   * Clave de exclusión por proyecto: dos tareas con la misma clave nunca están en curso a la vez (modo local: la
   * misma carpeta del usuario). `undefined` = sin restricción (worktrees).
   */
  exclusiveKey?: (projectId: string) => string | undefined;
  /** El workspace es la carpeta del usuario en modo local (cambia el encargo: sin commits ni ramas). */
  isLocal?: (workspace: Workspace) => boolean;
  memoryBudgetChars?: number;
  maxRounds?: number;
  rulesFiles?: readonly string[];
  timeoutMs?: number;
  /** Conserva el worktree de una tarea fallida o cancelada para revisarla a mano (por defecto, sí). */
  keepFailedWorkspaces?: boolean;
  /**
   * Tope de gasto por tarea según la dificultad (por defecto `DEFAULT_TASK_BUDGET_USD`); `null` lo desactiva. Al
   * llegar a él la tarea se detiene: queda `failed` con el motivo y lo hecho en `.orq/HANDOFF.md`, lista para
   * reintentar. Cuenta lo que informan los agentes (Claude y la API; Codex y agy gastan cupo, no USD).
   */
  taskBudgetUsd?: TaskBudgets | null;
  /**
   * Gate del proyecto antes de la revisión (por defecto, `workspaces.verify` si el gestor lo tiene). Si falla, la
   * tarea vuelve al autor sin gastar una revisión; si pasa, su resumen va en el encargo y el revisor no repite el check.
   */
  verify?: VerifyWorkspace;
  onHandoff?: (handoff: Handoff) => void | Promise<void>;
  warn?: (message: string) => void;
}

export interface TaskReport {
  taskId: string;
  state: TaskState;
  /** Agentes que escribieron código, en orden. */
  authors: string[];
  reviewers: string[];
  handoffs: Handoff[];
  rounds: number;
  workspace?: Workspace;
  review?: ReviewVerdict;
  integration?: IntegrationResult;
  detail?: string;
  /** Avisos que no hacen fallar la tarea (p. ej. el autor no escribió `.orq/PLAN-TAREA.md`). */
  warnings: string[];
  /** Plan general y estado de `.orq/PLAN-TAREA.md` en la última comprobación. */
  plan?: TaskPlanReport;
  /** USD que informaron los agentes de la tarea en este ciclo (autores y revisores). */
  spentUsd: number;
}

export interface TaskPlanReport {
  /** Id del plan general (`plan-…`) o, si la tarea es suelta, el de la tarea. */
  id: string;
  source: 'plan' | 'tarea';
  /** Nota del plan en la memoria (sin `.md`), si se guardó. */
  note?: string;
  /** `.orq/PLAN-TAREA.md` tras el último intento del autor. */
  exists: boolean;
  done: number;
  pending: number;
}

export interface FleetReport {
  tasks: TaskReport[];
  states: Record<string, TaskState>;
}

/** Plan general resuelto para una tarea. */
interface ResolvedPlan {
  id: string;
  source: 'plan' | 'tarea';
  /** Contenido de `.orq/PLAN.md`. */
  file: string;
  /** Nota de memoria guardada (sin `.md`). */
  note?: string;
}

interface TaskRun {
  task: TaskBrief;
  report: TaskReport;
  /** Intentos de los autores (no de los revisores), en orden. */
  attempts: AttemptResult[];
  workspace?: Workspace;
  /** Estado de `.orq/PLAN-TAREA.md` al terminar cada intento de autor (índice en `attempts`). */
  planChecks: Map<number, TaskPlanStatus>;
  /** USD gastados por la tarea en este ciclo (autores y revisores), para su tope. */
  spentUsd: number;
}

/** Lo que devuelve la etapa de revisión (gate previo + revisor). */
interface ReviewStep {
  verdict?: ReviewVerdict;
  reviewer?: string;
  cancelled?: boolean;
  /** Se llegó al tope de gasto de la tarea. */
  overBudget?: boolean;
  /** El gate previo falló: resumen para el autor (no hubo revisión). */
  gateFailed?: string;
  error?: string;
}

/**
 * Ciclo completo por tarea: workspace → contexto de memoria → `renderBrief` → ejecutar (Supervisor) → revisión por
 * otro agente → integrar → `recordSession` → limpiar. Un rechazo o un fallo de integración devuelve la tarea al autor
 * con las observaciones; dos seguidos la reasignan a Claude (regla del plan, §4.4).
 */
export class Fleet {
  readonly #queue: TaskQueue;
  readonly #router: Router;
  readonly #supervisor: Supervisor;
  readonly #workspaces: WorkspaceManager;
  readonly #memory: MemoryStore;
  readonly #writeFile: (path: string, content: string) => Promise<void>;
  readonly #readFile: (path: string) => Promise<string | undefined>;
  readonly #planFor: PlanFor | undefined;
  readonly #planMemory: PlanMemory | undefined;
  readonly #diffSummary: (workspace: Workspace, task: TaskBrief, run: ExecuteResult) => Promise<string>;
  readonly #exclusiveKey: (projectId: string) => string | undefined;
  readonly #isLocal: (workspace: Workspace) => boolean;
  /** Claves de exclusión de las tareas con su ciclo en curso. */
  readonly #exclusive = new Map<string, string>();
  readonly #memoryBudget: number;
  readonly #maxRounds: number;
  readonly #rulesFiles: readonly string[] | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #keepFailed: boolean;
  readonly #budgets: TaskBudgets | undefined;
  readonly #verify: VerifyWorkspace | undefined;
  readonly #onHandoff: ((handoff: Handoff) => void | Promise<void>) | undefined;
  readonly #warn: (message: string) => void;
  readonly #controllers = new Map<string, AbortController>();
  /** Tareas que pasaron el punto de compromiso: `integrate()` en curso, ya no se cancelan. */
  readonly #committing = new Set<string>();
  /** Cancelaciones pedidas durante la integración: se aplican solo si la integración falla. */
  readonly #cancelAfterCommit = new Map<string, string>();
  /** Tareas cuyo ciclo aún no terminó (también mientras se guardan sesiones y se limpia el worktree). */
  readonly #inFlight = new Set<string>();

  constructor(opts: FleetOptions) {
    this.#queue = opts.queue;
    this.#router = opts.router;
    this.#supervisor = opts.supervisor;
    this.#workspaces = opts.workspaces;
    this.#memory = opts.memory;
    this.#writeFile = opts.writeFile ?? writeUtf8;
    this.#readFile = opts.readFile ?? readUtf8IfExists;
    this.#planFor = opts.planFor;
    this.#planMemory = opts.planMemory === null ? undefined : (opts.planMemory ?? asPlanMemory(opts.memory));
    this.#diffSummary = opts.diffSummary ?? (async (_ws, _task, run) => defaultDiffSummary(run));
    this.#exclusiveKey = opts.exclusiveKey ?? (() => undefined);
    this.#isLocal = opts.isLocal ?? (() => false);
    this.#memoryBudget = opts.memoryBudgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS;
    this.#maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.#rulesFiles = opts.rulesFiles;
    this.#timeoutMs = opts.timeoutMs;
    this.#keepFailed = opts.keepFailedWorkspaces ?? true;
    this.#budgets = opts.taskBudgetUsd === null ? undefined : (opts.taskBudgetUsd ?? DEFAULT_TASK_BUDGET_USD);
    this.#verify = opts.verify ?? asVerifier(opts.workspaces);
    this.#onHandoff = opts.onHandoff;
    this.#warn = opts.warn ?? ((message) => console.warn(message));
  }

  /**
   * Ejecuta la cola hasta que no queden tareas listas ni activas (respeta su límite de concurrencia). El bucle
   * despierta cuando termina una tarea y también cuando otra pasa a `ready` (aprobada o liberada mientras las demás
   * corren), para arrancarla enseguida si hay cupo.
   */
  async run(opts: { signal?: AbortSignal } = {}): Promise<FleetReport> {
    const running = new Map<string, Promise<void>>();
    const reports: TaskReport[] = [];
    const onAbort = () => {
      for (const controller of this.#controllers.values()) controller.abort();
    };
    // Despertador: lo resuelve la cola al pasar una tarea a `ready`. `readied` cubre el cambio que llegue antes de
    // armar la espera, para no dormirse con una tarea lista.
    let readied = false;
    let wake: (() => void) | undefined;
    const unsubscribe = this.#queue.on((change) => {
      if (change.to !== 'ready') return;
      readied = true;
      wake?.();
    });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        readied = false;
        if (!opts.signal?.aborted) {
          const canStart = (t: TaskBrief) => {
            // Reintentada mientras su ciclo anterior aún guarda sesiones o limpia: espera a que ese job termine.
            if (this.#inFlight.has(t.id)) return false;
            const key = this.#keyOf(t);
            return key === undefined || ![...this.#exclusive.values()].includes(key);
          };
          for (let task = this.#queue.next(canStart); task; task = this.#queue.next(canStart)) {
            const id = task.id;
            const key = this.#keyOf(task);
            if (key !== undefined) this.#exclusive.set(id, key);
            const job = this.#runTask(task)
              .then((r) => { reports.push(r); })
              .catch((err: unknown) => { this.#warn(`${id}: ${err instanceof Error ? err.message : String(err)}`); })
              .finally(() => {
                if (running.get(id) !== job) return; // la entrada ya es de otro ciclo con el mismo id
                running.delete(id);
                this.#exclusive.delete(id);
              });
            running.set(id, job);
          }
        }
        if (running.size === 0) break;
        if (readied) continue;
        const woken = new Promise<void>((resolve) => { wake = resolve; });
        try {
          await Promise.race([...running.values(), woken]);
        } finally {
          wake = undefined;
        }
      }
    } finally {
      unsubscribe();
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const states: Record<string, TaskState> = {};
    for (const entry of this.#queue.list()) states[entry.task.id] = entry.state;
    return { tasks: reports, states };
  }

  /**
   * Cancela una tarea (y, en la cola, sus dependientes) y detiene a su agente. Devuelve false si ya terminó o si
   * se está integrando: pasado ese punto de compromiso la cancelación se ignora y, si la integración sale bien,
   * la tarea queda `integrated`; si falla, entonces se cancela.
   */
  cancel(taskId: string, detail = 'cancelada por el usuario'): boolean {
    if (this.#committing.has(taskId)) {
      this.#cancelAfterCommit.set(taskId, detail);
      this.#warn(`${taskId}: se está integrando; la cancelación se ignora salvo que la integración falle.`);
      return false;
    }
    const cancelled = this.#queue.cancel(taskId, detail);
    this.#controllers.get(taskId)?.abort();
    return cancelled;
  }

  /** Ids de las tareas con su ciclo en curso: ejecución, revisión, integración, registro o limpieza. */
  inFlight(): string[] {
    return [...this.#inFlight];
  }

  /** Clave de exclusión de la tarea; si falla la consulta, sin clave (la creación del workspace dará el error). */
  #keyOf(task: TaskBrief): string | undefined {
    try {
      return this.#exclusiveKey(task.projectId);
    } catch {
      return undefined;
    }
  }

  async #runTask(task: TaskBrief): Promise<TaskReport> {
    this.#inFlight.add(task.id);
    try {
      const controller = new AbortController();
      this.#controllers.set(task.id, controller);
      const run: TaskRun = {
        task,
        attempts: [],
        planChecks: new Map(),
        spentUsd: 0,
        report: { taskId: task.id, state: 'running', authors: [], reviewers: [], handoffs: [], rounds: 0, warnings: [], spentUsd: 0 },
      };
      let finalOutcome: 'ok' | 'failed' = 'failed';
      try {
        finalOutcome = await this.#cycle(run, controller.signal);
      } catch (err) {
        this.#fail(run, `Error del orquestador: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#controllers.delete(task.id);
        this.#committing.delete(task.id);
        this.#cancelAfterCommit.delete(task.id);
      }
      await this.#recordSessions(run, finalOutcome);
      await this.#cleanup(run, finalOutcome);
      run.report.state = this.#queue.state(task.id);
      return run.report;
    } finally {
      this.#inFlight.delete(task.id);
    }
  }

  async #cycle(run: TaskRun, signal: AbortSignal): Promise<'ok' | 'failed'> {
    const { task, report } = run;
    const workspace = await this.#workspaces.create(task.projectId, task);
    run.workspace = workspace;
    report.workspace = workspace;
    const local = this.#isLocal(workspace) ? { path: workspace.path } : undefined;
    const memoryContext = await this.#memoryContext(task);
    const plan = await this.#generalPlan(task);
    report.plan = { id: plan.id, source: plan.source, ...(plan.note ? { note: plan.note } : {}), exists: false, done: 0, pending: 0 };
    /**
     * Antes de cada intento: `.orq/PLAN.md` y `.orq/BRIEF.md`. Para el autor, además, comprueba el plan de la tarea
     * del intento que acaba de terminar y agrega sus pasos pendientes al resumen del traspaso. El Supervisor pasa ese
     * mismo objeto `Handoff` al adaptador y lo guarda en sus traspasos: se completa en su sitio.
     */
    const writeFiles = (role: 'author' | 'reviewer') => async (info: BeforeAttemptInfo) => {
      if (role === 'author' && info.handoff) {
        const status = info.attempt > 1
          ? await this.#checkTaskPlan(run, run.attempts.length + info.attempt - 2, info.handoff.fromAgent)
          : await this.#readTaskPlan(run);
        info.handoff.partialSummary = withTaskPlanNote(info.handoff.partialSummary, status);
      }
      await this.#writeFile(join(workspace.path, PLAN_FILE), plan.file);
      await this.#writeFile(join(workspace.path, BRIEF_FILE), renderBrief(info.task, info.handoff, { memoryContext, rulesFiles: this.#rulesFiles, ...(local ? { local } : {}) }));
    };

    const decision = await this.#router.route(task);
    for (const w of decision.warnings) this.#warn(`${task.id}: ${w}`);
    let author = decision.agentId;
    this.#queue.assign(task.id, author);
    let current = task;
    let handoff: Handoff | undefined;
    let streak = 0;

    for (let round = 1; round <= this.#maxRounds; round++) {
      report.rounds = round;
      // Cada ronda de corrección cuenta como reintento: el autor piensa un nivel más (`RunHints.retries`).
      const exec = await this.#supervisor.execute(current, {
        agentId: author, worktreePath: workspace.path, signal, timeoutMs: this.#timeoutMs, handoff, beforeAttempt: writeFiles('author'),
        retryBase: round - 1, ...this.#budgetOf(run),
      });
      this.#spend(run, exec);
      run.attempts.push(...exec.attempts);
      for (const a of exec.authors) if (!report.authors.includes(a)) report.authors.push(a);
      report.handoffs.push(...exec.handoffs);
      if (exec.outcome === 'cancelled' || signal.aborted) return this.#cancelled(run, exec.error);
      // Al terminar el intento: ¿escribió el autor su plan? Solo avisa (Codex, en su sandbox, a veces no escribe en `.orq/`).
      const planStatus = exec.attempts.length ? await this.#checkTaskPlan(run, run.attempts.length - 1, exec.agentId) : await this.#readTaskPlan(run);
      if (exec.outcome === 'budget') return this.#overBudget(run);
      if (!exec.ok) return this.#fail(run, exec.error ?? 'el agente no terminó la tarea');
      // La racha es del agente efectivo: si dentro de execute() la tarea pasó a otro (p. ej. por cupo),
      // sus fallos de integración empiezan de cero.
      if (exec.agentId !== author) streak = 0;
      author = exec.agentId;

      this.#move(task.id, 'review', { agentId: author, detail: `ronda ${round} · ${taskPlanDetail(planStatus)}` });
      const review = await this.#review(run, exec, signal, writeFiles('reviewer'), planStatus, plan.source);
      if (review.cancelled || signal.aborted) return this.#cancelled(run);
      if (review.overBudget) return this.#overBudget(run);

      let problem: { source: string; notes: string[] };
      if (review.gateFailed !== undefined) {
        // El gate previo falló: vuelve al autor sin gastar una revisión.
        problem = { source: 'verificación del proyecto', notes: [`La verificación del proyecto (gate) falló en el worktree:\n${review.gateFailed}`] };
      } else if (!review.verdict) {
        return this.#fail(run, review.error ?? 'la revisión no entregó un veredicto válido');
      } else if (review.verdict.veredicto === 'aprobado') {
        report.review = review.verdict;
        // Punto de compromiso: una cancelación anterior impide integrar; una posterior se ignora (ver `cancel`).
        if (signal.aborted || !this.#queue.canTransition(task.id, 'integrated')) return this.#cancelled(run);
        this.#committing.add(task.id);
        let integration: IntegrationResult;
        try {
          integration = await this.#workspaces.integrate(task.projectId, workspace);
        } finally {
          this.#committing.delete(task.id);
        }
        report.integration = integration;
        if (integration.ok) {
          this.#cancelAfterCommit.delete(task.id);
          this.#move(task.id, 'integrated', { agentId: author, detail: integration.commit ? `commit ${integration.commit}` : undefined });
          return 'ok';
        }
        const deferred = this.#cancelAfterCommit.get(task.id);
        if (deferred !== undefined || signal.aborted) {
          this.#cancelAfterCommit.delete(task.id);
          return this.#cancelled(run, deferred);
        }
        const notes = [...integration.conflicts.map((f) => `Conflicto al integrar: ${f}`)];
        if (integration.gateSummary.trim()) notes.push(`Verificación del proyecto: ${integration.gateSummary.trim()}`);
        problem = { source: 'integración', notes: notes.length ? notes : ['La integración falló sin detalle.'] };
      } else {
        report.review = review.verdict;
        problem = { source: `revisión de ${review.reviewer ?? 'otro agente'}`, notes: review.verdict.observaciones };
      }

      streak++;
      if (round === this.#maxRounds) return this.#fail(run, `${problem.source}: ${problem.notes.join(' | ')} (sin rondas restantes)`);
      current = withFeedback(task, { ...problem, round });
      handoff = undefined;
      const next = await this.#reworkAgent(author, streak);
      if (next !== author) {
        const last = run.attempts.at(-1);
        try {
          if (last) {
            handoff = await this.#supervisor.buildHandoff(current, last, {
              toAgent: next, reason: 'failure', worktreePath: workspace.path,
              note: `Observaciones (${problem.source}): ${problem.notes.join(' | ')}\n${taskPlanNote(planStatus)}`,
            });
            report.handoffs.push(handoff);
            await this.#notifyHandoff(handoff);
          }
        } catch (err) {
          // Sin traspaso el nuevo agente aún tiene las observaciones en el objetivo; el arriendo ya es suyo.
          this.#warn(`${task.id}: traspaso sin resumen (${err instanceof Error ? err.message : String(err)}).`);
        }
        streak = 0;
      }
      this.#move(task.id, 'running', { agentId: next, detail: `${problem.source} → vuelve a ${next}` });
      author = next;
    }
    return this.#fail(run, 'sin rondas restantes');
  }

  /**
   * Quién corrige tras un rechazo o un fallo de integración: el mismo autor; tras dos seguidos (o si el autor ya
   * no tiene cupo), un Claude. Devuelve el agente ya arrendado.
   */
  async #reworkAgent(author: string, streak: number): Promise<string> {
    let toClaude = streak >= 2;
    if (!toClaude && !this.#router.isClaude(author)) {
      const quota = await this.#router.checkQuota(author);
      for (const w of quota.warnings) this.#warn(w);
      toClaude = !quota.allowed;
    }
    if (!toClaude) {
      this.#router.acquire(author);
      return author;
    }
    const isClaude = this.#router.isClaude(author);
    try {
      return this.#router.pickClaude({ exclude: isClaude ? [author] : [] }).agentId;
    } catch (err) {
      if (!(err instanceof RoutingError) || !isClaude) throw err;
      this.#router.acquire(author); // no hay otro Claude: sigue el mismo
      return author;
    }
  }

  /**
   * Etapa de revisión: resumen del diff (confirma el trabajo), gate del proyecto sin LLM y, si pasa, el revisor con
   * el resumen del gate en su encargo (no repite el check). Si el gate falla, no hay revisión.
   */
  async #review(
    run: TaskRun,
    exec: ExecuteResult,
    signal: AbortSignal,
    writeFiles: (info: BeforeAttemptInfo) => Promise<void>,
    planStatus: TaskPlanStatus,
    planSource: ResolvedPlan['source'],
  ): Promise<ReviewStep> {
    const { task, report } = run;
    const workspace = run.workspace;
    if (!workspace) return { error: 'sin workspace' };
    let diff: string;
    try {
      diff = await this.#diffSummary(workspace, task, exec);
    } catch (err) {
      this.#warn(`${task.id}: no se pudo resumir el diff (${err instanceof Error ? err.message : String(err)}).`);
      diff = defaultDiffSummary(exec);
    }
    // Después del resumen del diff (que confirma el trabajo): así los restos del gate no se cuelan en el commit.
    const gate = await this.#runGate(run, signal);
    if (signal.aborted) return { cancelled: true };
    if (gate && !gate.ok) return { gateFailed: gate.summary };
    const reviewTask = buildReviewTask(task, report.authors, diff, planStatus.exists ? planStatus.text : undefined, {
      ...(gate ? { gate: gate.summary } : {}),
      generalPlan: planSource === 'plan',
    });
    const tried: string[] = [];
    let error = 'la revisión no entregó un veredicto válido';
    for (let i = 0; i < REVIEW_TRIES; i++) {
      const decision = await this.#router.chooseReviewer(task, [...report.authors, ...tried]);
      for (const w of decision.warnings) this.#warn(`${task.id} (revisión): ${w}`);
      const result = await this.#supervisor.execute(reviewTask, {
        agentId: decision.agentId,
        worktreePath: workspace.path,
        signal,
        timeoutMs: this.#timeoutMs,
        exclude: report.authors, // un traspaso de la revisión tampoco puede caer en un autor
        maxAttempts: REVIEW_MAX_ATTEMPTS,
        updateQueue: false,
        beforeAttempt: writeFiles,
        retryBase: i,
        ...this.#budgetOf(run),
      });
      this.#spend(run, result);
      for (const r of result.authors) {
        if (!report.reviewers.includes(r)) report.reviewers.push(r);
        tried.push(r);
      }
      report.handoffs.push(...result.handoffs);
      const touched = [...new Set(result.attempts.flatMap((a) => a.filesChanged))].filter((f) => !normalizeOwnedPath(f).startsWith('.orq/'));
      if (touched.length) this.#warn(`${task.id}: el revisor ${result.agentId} modificó archivos del proyecto: ${touched.join(', ')}.`);
      if (result.outcome === 'cancelled') return { cancelled: true };
      if (result.outcome === 'budget') return { overBudget: true, ...(result.error ? { error: result.error } : {}) };
      const last = result.attempts.at(-1);
      const verdict = result.ok && last ? parseReviewVerdict([...last.texts, ...(last.summary ? [last.summary] : [])]) : undefined;
      if (verdict) return { verdict, reviewer: result.agentId };
      error = result.ok ? `${result.agentId} no entregó un veredicto válido` : (result.error ?? 'la revisión falló');
      this.#warn(`${task.id}: ${error}`);
    }
    return { error };
  }

  /** Gate del proyecto en el worktree de la tarea (sin LLM). Si no se puede correr, el revisor lo comprueba como antes. */
  async #runGate(run: TaskRun, signal: AbortSignal): Promise<GateCheck | undefined> {
    if (!this.#verify || !run.workspace) return undefined;
    try {
      const check = await this.#verify(run.workspace, run.task, signal);
      if (!check) return undefined;
      const summary = redactSecrets(check.summary.trim() || (check.ok ? 'gate ok' : 'gate fallido sin detalle'));
      return { ok: check.ok, summary: summary.length > GATE_SUMMARY_MAX ? `…${summary.slice(summary.length - GATE_SUMMARY_MAX + 1)}` : summary };
    } catch (err) {
      this.#warn(`${run.task.id}: no se pudo correr la verificación antes de revisar (${err instanceof Error ? err.message : String(err)}); la comprueba el revisor.`);
      return undefined;
    }
  }

  /** Tope de gasto de la tarea según su dificultad (`undefined`: sin tope). */
  #taskCap(task: TaskBrief): number | undefined {
    const cap = this.#budgets?.[task.difficulty];
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : undefined;
  }

  /** Lo que la tarea aún puede gastar, para `Supervisor.execute`. */
  #budgetOf(run: TaskRun): Pick<ExecuteOptions, 'budgetUsd'> {
    const cap = this.#taskCap(run.task);
    return cap === undefined ? {} : { budgetUsd: cap - run.spentUsd };
  }

  #spend(run: TaskRun, exec: ExecuteResult): void {
    run.spentUsd += exec.spentUsd;
    run.report.spentUsd = run.spentUsd;
  }

  /**
   * La tarea llegó a su tope de gasto: se detiene con lo hecho en `.orq/HANDOFF.md` (para que el reintento continúe
   * desde ahí), avisa y queda `failed` con el motivo.
   */
  async #overBudget(run: TaskRun): Promise<'failed'> {
    const { task } = run;
    const cap = this.#taskCap(task) ?? 0;
    const detail = `tope de gasto de la tarea superado: ${run.spentUsd.toFixed(2)} de ${cap} USD (dificultad ${task.difficulty}); lo hecho queda en ${PLAN_FILES.handoff}: reintenta para continuar desde ahí`;
    if (run.workspace) {
      const file = join(run.workspace.path, HANDOFF_FILE);
      try {
        let existing: string | undefined;
        try {
          existing = await this.#readFile(file);
        } catch {
          existing = undefined;
        }
        const last = run.attempts.at(-1);
        const section = [`## Detenida por el tope de gasto (${new Date().toISOString()})`, `Berland detuvo la tarea: ${detail}.`];
        if (last) section.push('', summarizeAttempt(last, { maxChars: 3_000 }));
        const body = existing?.trim() ? `${existing.trimEnd()}\n\n${section.join('\n')}\n` : `# Traspaso de ${task.id}\n\n${section.join('\n')}\n`;
        await this.#writeFile(file, redactSecrets(body));
      } catch (err) {
        this.#warn(`${task.id}: no se pudo escribir ${PLAN_FILES.handoff} (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
    this.#warn(`${task.id}: ${detail}.`);
    return this.#fail(run, detail);
  }

  /**
   * Plan general de la tarea: el del plan del que sale (`planFor`) o uno mínimo generado del encargo. Se guarda en la
   * memoria (una nota por plan, compartida por sus tareas). Ninguno de los dos pasos hace fallar la tarea.
   */
  async #generalPlan(task: TaskBrief): Promise<ResolvedPlan> {
    let found: GeneralPlan | string | undefined;
    try {
      found = await this.#planFor?.(task);
    } catch (err) {
      this.#warn(`${task.id}: sin plan general (${err instanceof Error ? err.message : String(err)}); se usa el plan mínimo del encargo.`);
    }
    const plan: GeneralPlan | undefined = typeof found === 'string' ? (found.trim() ? { text: found } : undefined) : found?.text.trim() ? found : undefined;
    const id = plan?.id && idSchema.safeParse(plan.id).success ? plan.id : task.id;
    const resolved: ResolvedPlan = { id, source: plan ? 'plan' : 'tarea', file: renderPlanFile(task, plan) };
    if (this.#planMemory) {
      const taskIds = [...new Set([...(plan?.tasks ?? []).map((t) => t.id), task.id])];
      try {
        resolved.note = await this.#planMemory.recordPlan({
          projectId: task.projectId,
          planId: id,
          title: planTitle(task, plan),
          text: renderPlanFile(task, plan, { forMemory: true }),
          taskIds,
          at: new Date().toISOString(),
        });
      } catch (err) {
        this.#warn(`${task.id}: no se pudo guardar el plan en la memoria (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
    return resolved;
  }

  async #readTaskPlan(run: TaskRun): Promise<TaskPlanStatus> {
    if (!run.workspace) return parseTaskPlan(undefined);
    try {
      return parseTaskPlan(await this.#readFile(join(run.workspace.path, TASK_PLAN_FILE)));
    } catch (err) {
      this.#warn(`${run.task.id}: no se pudo leer ${PLAN_FILES.taskPlan} (${err instanceof Error ? err.message : String(err)}).`);
      return parseTaskPlan(undefined);
    }
  }

  /** Comprueba `.orq/PLAN-TAREA.md` tras el intento `index` de `agentId`: lo anota y avisa si falta (no hace fallar). */
  async #checkTaskPlan(run: TaskRun, index: number, agentId: string): Promise<TaskPlanStatus> {
    const status = await this.#readTaskPlan(run);
    if (index >= 0) run.planChecks.set(index, status);
    if (run.report.plan) Object.assign(run.report.plan, { exists: status.exists, done: status.done, pending: status.pending });
    const problem = taskPlanProblem(status);
    if (problem) this.#addWarning(run, `${run.task.id}: ${agentId} ${problem} (aviso: la tarea sigue).`);
    return status;
  }

  #addWarning(run: TaskRun, message: string): void {
    const text = redactSecrets(message);
    if (run.report.warnings.includes(text)) return;
    run.report.warnings.push(text);
    this.#warn(text);
  }

  async #memoryContext(task: TaskBrief): Promise<string> {
    try {
      return await this.#memory.buildContext(task.projectId, task, this.#memoryBudget);
    } catch (err) {
      this.#warn(`${task.id}: sin contexto de memoria (${err instanceof Error ? err.message : String(err)}).`);
      return '';
    }
  }

  /** Una nota por turno de cada autor: quien traspasó queda `handed_off`; el último, según el resultado. */
  async #recordSessions(run: TaskRun, outcome: 'ok' | 'failed'): Promise<void> {
    const groups: { attempts: AttemptResult[]; last: number }[] = [];
    for (const [index, attempt] of run.attempts.entries()) {
      const current = groups.at(-1);
      if (current && current.attempts[0]?.agentId === attempt.agentId) {
        current.attempts.push(attempt);
        current.last = index;
      } else {
        groups.push({ attempts: [attempt], last: index });
      }
    }
    for (const [i, { attempts: group, last: lastIndex }] of groups.entries()) {
      const first = group[0];
      const last = group.at(-1);
      if (!first || !last) continue;
      const files = [...new Set(group.flatMap((a) => a.filesChanged))];
      const summaryText = last.summary ?? last.texts.at(-1) ?? last.error?.message ?? '';
      const costs = group.map((a) => a.usage.costUsd).filter((c): c is number => c !== undefined);
      const session: SessionSummary & { plan?: SessionPlanInfo } = {
        projectId: run.task.projectId,
        taskId: run.task.id,
        agentId: first.agentId,
        title: run.task.title,
        outcome: i < groups.length - 1 ? 'handed_off' : outcome,
        summary: redactSecrets(summaryText).slice(0, 2_000),
        filesChanged: files,
        inputTokens: group.reduce((n, a) => n + a.usage.inputTokens, 0),
        outputTokens: group.reduce((n, a) => n + a.usage.outputTokens, 0),
        at: last.endedAt,
      };
      if (costs.length) session.costUsd = costs.reduce((n, c) => n + c, 0);
      // Enlace a la nota del plan y pasos de `.orq/PLAN-TAREA.md` al terminar el turno (fuera del resumen: no
      // agrandan el contexto de memoria de los encargos siguientes).
      const check = run.planChecks.get(lastIndex);
      const plan: SessionPlanInfo = {
        ...(run.report.plan?.note ? { id: run.report.plan.id } : {}),
        ...(check ? { exists: check.exists, done: check.done, pending: check.pending } : {}),
      };
      if (Object.keys(plan).length) session.plan = plan;
      try {
        await this.#memory.recordSession(session);
      } catch (err) {
        this.#warn(`${run.task.id}: no se pudo guardar la sesión de ${first.agentId} (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
  }

  async #cleanup(run: TaskRun, outcome: 'ok' | 'failed'): Promise<void> {
    if (!run.workspace || (outcome !== 'ok' && this.#keepFailed)) return;
    try {
      await this.#workspaces.remove(run.workspace);
    } catch (err) {
      this.#warn(`${run.task.id}: no se pudo limpiar el worktree (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  #fail(run: TaskRun, detail: string): 'failed' {
    run.report.detail = redactSecrets(detail);
    this.#move(run.task.id, 'failed', { detail: run.report.detail });
    return 'failed';
  }

  #cancelled(run: TaskRun, detail = 'cancelada'): 'failed' {
    run.report.detail = detail;
    if (this.#queue.state(run.task.id) !== 'cancelled') this.#queue.cancel(run.task.id, detail);
    return 'failed';
  }

  /** Transición tolerante: si la tarea ya cambió (p. ej. la cancelaron), no hace nada. */
  #move(taskId: string, to: TaskState, info: { agentId?: string; detail?: string }): void {
    if (this.#queue.canTransition(taskId, to)) this.#queue.transition(taskId, to, info);
  }

  async #notifyHandoff(handoff: Handoff): Promise<void> {
    try {
      await this.#onHandoff?.(handoff);
    } catch (err) {
      this.#warn(`Error al notificar un traspaso: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export interface ReviewTaskOptions {
  /** Resumen del gate que ya pasó en el worktree: el revisor no repite el check completo. */
  gate?: string;
  /** La tarea sale de un plan general (`.orq/PLAN.md` con tareas hermanas); si no, ese archivo no aporta nada. */
  generalPlan?: boolean;
}

/**
 * Encargo de revisión: mismo worktree, sin tocar el proyecto, veredicto en JSON en la última línea. Incluye el plan
 * de la tarea del autor (`.orq/PLAN-TAREA.md`, recortado a 4000 caracteres) para comparar el trabajo con lo planeado
 * y, si el gate ya pasó, su resumen: el revisor lee el diff y corre solo pruebas puntuales.
 */
export function buildReviewTask(task: TaskBrief, authors: readonly string[], diffSummary: string, taskPlan?: string, opts: ReviewTaskOptions = {}): TaskBrief {
  const plan = taskPlan?.trim() ? clipTaskPlan(taskPlan) : `(el autor no escribió \`${PLAN_FILES.taskPlan}\`)`;
  const gate = opts.gate?.trim();
  const objective = [
    `Revisa el trabajo de la tarea «${task.id}: ${task.title}», hecho por ${authors.join(' → ') || 'otro agente'}, en este mismo worktree.`,
    'Eres el revisor: no modifiques archivos del proyecto.',
    '',
    '### Objetivo de la tarea',
    task.objective,
    '',
    '### Rutas propias de la tarea',
    ...task.ownedPaths.map((p) => `- \`${p}\``),
    '',
    '### Criterios de aceptación de la tarea',
    ...task.acceptance.map((a) => `- ${a}`),
    '',
    `### Plan de la tarea (\`${PLAN_FILES.taskPlan}\` del autor)`,
    redactSecrets(plan),
    '',
    '### Resumen del diff',
    redactSecrets(diffSummary.trim() || '(sin resumen)'),
    '',
    ...(gate
      ? [
          '### Verificación del proyecto (gate)',
          'Berland ya la corrió en este worktree, sin LLM, y pasó:',
          redactSecrets(gate),
          'No vuelvas a correr la verificación completa (`npm run check` o equivalente). Si dudas de un cambio concreto, corre solo la prueba de ese archivo.',
          '',
          'Comprueba con `git diff` de esta rama que el cambio cumple cada criterio y que solo toca las rutas propias.',
        ]
      : ['Comprueba con `git status`, `git diff` y `git log` de esta rama que el cambio cumple cada criterio, que solo toca las rutas propias y que la verificación del proyecto pasa.']),
    ...(opts.generalPlan ? [`Si necesitas el contexto de las tareas hermanas, el plan general está en \`${PLAN_FILES.plan}\`.`] : []),
    'Compara el trabajo con el plan de la tarea: los pasos marcados `- [x]` deben estar hechos de verdad; menciona los pendientes que afecten a los criterios.',
    'Rechaza solo por problemas concretos y di cómo corregirlos.',
    'Termina tu respuesta con una sola línea JSON: {"veredicto":"aprobado","observaciones":[]} o {"veredicto":"rechazado","observaciones":["…"]}.',
  ].join('\n');
  return taskBriefSchema.parse({
    id: `${task.id.slice(0, 55)}-revision`,
    projectId: task.projectId,
    title: `Revisión: ${task.title}`.slice(0, 120),
    objective,
    ownedPaths: ['.orq/REVISION.md'],
    dependsOn: [],
    acceptance: [
      'Veredicto en la última línea, en JSON de una sola línea con «veredicto» («aprobado» o «rechazado») y «observaciones».',
      'Ningún archivo del proyecto modificado.',
    ],
    difficulty: task.difficulty,
    contextRefs: task.contextRefs,
    skillRefs: task.skillRefs,
  });
}

/** Busca el último veredicto JSON válido en los textos del revisor (los más recientes al final). */
export function parseReviewVerdict(texts: readonly string[]): ReviewVerdict | undefined {
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i] ?? '';
    const candidates: string[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim().replace(/^`+|`+$/g, '');
      if (t.startsWith('{') && t.endsWith('}')) candidates.push(t);
    }
    for (const m of text.matchAll(/\{[^{}]*"veredicto"[^{}]*\}/g)) candidates.push(m[0]);
    for (let j = candidates.length - 1; j >= 0; j--) {
      try {
        const parsed = reviewVerdictSchema.safeParse(JSON.parse(candidates[j] ?? ''));
        if (parsed.success) return parsed.data;
      } catch {
        // no es JSON: se prueba el siguiente
      }
    }
  }
  return undefined;
}

/** La misma tarea con las observaciones de la ronda anterior al final del objetivo. */
export function withFeedback(task: TaskBrief, feedback: { source: string; notes: readonly string[]; round: number }): TaskBrief {
  const notes = feedback.notes.length ? feedback.notes : ['(sin observaciones concretas)'];
  const objective = [
    task.objective,
    '',
    `### Observaciones (${feedback.source}, ronda ${feedback.round})`,
    'Corrige esto en el mismo worktree, sin rehacer lo que ya funciona:',
    ...notes.map((n) => `- ${redactSecrets(n)}`),
  ].join('\n');
  return { ...task, objective };
}

function defaultDiffSummary(run: ExecuteResult): string {
  const files = [...new Set(run.attempts.flatMap((a) => a.filesChanged))];
  const last = run.attempts.at(-1);
  const lines = [files.length ? `Archivos cambiados según los eventos del agente: ${files.join(', ')}.` : 'El agente no informó archivos cambiados.'];
  if (last?.summary) lines.push(`Resumen del autor: ${last.summary}`);
  else if (last?.texts.length) lines.push(`Último mensaje del autor: ${last.texts.at(-1) ?? ''}`);
  return lines.join('\n');
}

async function writeUtf8(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function readUtf8IfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * El gestor de workspaces sirve también para el gate previo a la revisión si implementa
 * `verify(workspace, task, signal)` (propuesto para `CommittingWorkspaces`).
 */
function asVerifier(workspaces: WorkspaceManager): VerifyWorkspace | undefined {
  const verify = (workspaces as WorkspaceManager & { verify?: VerifyWorkspace }).verify;
  return typeof verify === 'function' ? (workspace, task, signal) => verify.call(workspaces, workspace, task, signal) : undefined;
}

/** La memoria sirve también para los planes si implementa `recordPlan` (p. ej. `ObsidianMemory`). */
function asPlanMemory(memory: MemoryStore): PlanMemory | undefined {
  const recordPlan = (memory as MemoryStore & Partial<PlanMemory>).recordPlan;
  return typeof recordPlan === 'function' ? { recordPlan: (input) => recordPlan.call(memory, input) } : undefined;
}
