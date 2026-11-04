/**
 * Plan obligatorio de cada tarea (F5 §1.10): de dónde sale el plan general que la flota escribe en `.orq/PLAN.md`,
 * cómo se lee el plan de la tarea que escribe el agente (`.orq/PLAN-TAREA.md`) y el puerto para guardarlo en memoria.
 */
import type { TaskBrief } from '../../shared/index.ts';
import { PLAN_FILES, redactSecrets } from '../../shared/index.ts';
import type { GeneralPlan } from '../brief/render-plan.ts';

export type { GeneralPlan } from '../brief/render-plan.ts';

/**
 * Plan general del que sale una tarea. `undefined`: tarea suelta (la flota genera un plan mínimo del encargo). Un
 * texto se toma como el texto del plan, sin id ni tareas hermanas.
 */
export type PlanFor = (task: TaskBrief) => GeneralPlan | string | undefined | Promise<GeneralPlan | string | undefined>;

/** Lo que `planFromStore` lee del almacén. `SqliteStore` lo cumple tal cual. */
export interface PlanStoreReader {
  getTask(id: string): { planId: string | null } | undefined;
  getPlan(id: string): { id: string; text: string } | undefined;
  listTasks(filter: { planId: string }): readonly { task: TaskBrief }[];
}

/**
 * `PlanFor` sobre el almacén: `TaskRecord.planId` → `PlanRecord.text` y las tareas del mismo plan (las de
 * `POST /plans`, y las de `crear_tareas` si se guardan con `store.createPlan`). Una tarea sin plan es suelta.
 */
export function planFromStore(store: PlanStoreReader): PlanFor {
  return (task) => {
    const planId = store.getTask(task.id)?.planId;
    if (!planId) return undefined;
    const plan = store.getPlan(planId);
    if (!plan) return undefined;
    return { id: plan.id, text: plan.text, tasks: store.listTasks({ planId }).map((r) => r.task) };
  };
}

/** Nota del plan general en la memoria (`ObsidianMemory.recordPlan` lo cumple). Devuelve la ruta de la nota. */
export interface PlanNoteInput {
  projectId: string;
  /** Id del plan o, si la tarea es suelta, el de la tarea: nombre de la nota. */
  planId: string;
  title: string;
  text: string;
  taskIds: string[];
  at: string;
}
export interface PlanMemory {
  recordPlan(input: PlanNoteInput): Promise<string>;
}

/** Datos del plan que la flota agrega a cada `SessionSummary` (los entiende `ObsidianMemory.recordSession`). */
export interface SessionPlanInfo {
  /** Id de la nota del plan general (solo si se guardó). */
  id?: string;
  /** Si existía `.orq/PLAN-TAREA.md` al terminar el turno del agente. */
  exists?: boolean;
  done?: number;
  pending?: number;
}

// ── .orq/PLAN-TAREA.md ───────────────────────────────────────────────────────────────────────

export interface TaskPlanStatus {
  /** Existe `.orq/PLAN-TAREA.md` en el worktree. */
  exists: boolean;
  /** Pasos marcados `- [x]`. */
  done: number;
  /** Pasos sin marcar `- [ ]`. */
  pending: number;
  /** Texto de los pasos sin marcar, en orden (tachado, en una línea). */
  pendingSteps: string[];
  /** Contenido tachado (vacío si no existe). */
  text: string;
}

/** Tope del plan de la tarea que recibe el revisor. */
export const REVIEW_TASK_PLAN_CHARS = 4_000;
const MAX_STEP_CHARS = 300;
const MAX_PENDING_LISTED = 20;

/** Paso con casilla: `- [ ] …`, `* [x] …`, `1. [ ] …`. */
const STEP = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Lee el plan de la tarea: cuenta pasos hechos y pendientes (fuera de bloques de código). `undefined`: no existe. */
export function parseTaskPlan(content: string | undefined): TaskPlanStatus {
  if (content === undefined) return { exists: false, done: 0, pending: 0, pendingSteps: [], text: '' };
  const text = redactSecrets(content);
  let done = 0;
  const pendingSteps: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = STEP.exec(line);
    if (!m) continue;
    if (m[1] === ' ') pendingSteps.push(cut(oneLine(m[2] ?? ''), MAX_STEP_CHARS));
    else done++;
  }
  return { exists: true, done, pending: pendingSteps.length, pendingSteps, text };
}

/** Tiene al menos un paso con casilla. */
export function hasSteps(status: TaskPlanStatus): boolean {
  return status.done + status.pending > 0;
}

/** Aviso cuando falta el plan de la tarea (no hace fallar la tarea). `undefined` si está bien. */
export function taskPlanProblem(status: TaskPlanStatus): string | undefined {
  if (!status.exists) return `no escribió \`${PLAN_FILES.taskPlan}\``;
  if (!hasSteps(status)) return `dejó \`${PLAN_FILES.taskPlan}\` sin pasos \`- [ ]\``;
  return undefined;
}

/** Resumen corto para el detalle de la transición a `review`. */
export function taskPlanDetail(status: TaskPlanStatus): string {
  const problem = taskPlanProblem(status);
  return problem ? `aviso: el autor ${problem}` : `plan: ${status.done}/${status.done + status.pending} pasos hechos`;
}

/** Encabezado de la nota del plan en un traspaso (también sirve para no repetirla). */
export const TASK_PLAN_NOTE_MARK = `Plan de la tarea (\`${PLAN_FILES.taskPlan}\`)`;

/** Pasos pendientes para el siguiente agente (va al final del `partialSummary` del traspaso). */
export function taskPlanNote(status: TaskPlanStatus): string {
  if (!status.exists) return `${TASK_PLAN_NOTE_MARK}: no existe; escríbelo antes de seguir.`;
  if (!hasSteps(status)) return `${TASK_PLAN_NOTE_MARK}: no tiene pasos \`- [ ]\`; complétalo antes de seguir.`;
  if (status.pending === 0) return `${TASK_PLAN_NOTE_MARK}: los ${status.done} pasos están marcados como hechos.`;
  const listed = status.pendingSteps.slice(0, MAX_PENDING_LISTED).map((s) => `- [ ] ${s}`);
  const more = status.pending > MAX_PENDING_LISTED ? [`- … y ${status.pending - MAX_PENDING_LISTED} más`] : [];
  return [`${TASK_PLAN_NOTE_MARK}: ${status.done} hechos, ${status.pending} pendientes. Sigue desde el primero sin marcar:`, ...listed, ...more].join('\n');
}

/** El resumen de un traspaso con los pasos pendientes al final (idempotente). */
export function withTaskPlanNote(summary: string, status: TaskPlanStatus): string {
  if (summary.includes(TASK_PLAN_NOTE_MARK)) return summary;
  return redactSecrets(`${summary.trimEnd()}${summary.trim() ? '\n' : ''}${taskPlanNote(status)}`);
}

/** Plan de la tarea para el encargo de revisión, recortado a `REVIEW_TASK_PLAN_CHARS`. */
export function clipTaskPlan(text: string): string {
  const t = text.trim();
  return t.length <= REVIEW_TASK_PLAN_CHARS ? t : `${t.slice(0, REVIEW_TASK_PLAN_CHARS - 1)}…`;
}

/**
 * Planes de la mente (`crear_tareas`) en memoria del núcleo: sus tareas no pasan por `store.createPlan`, así que la
 * flota busca aquí su plan general cuando el almacén no lo tiene. Guarda los últimos `max` ids de tarea.
 */
export class PlanRegistry {
  readonly #byTask = new Map<string, GeneralPlan>();
  readonly #max: number;

  constructor(max = 2000) {
    this.#max = max;
  }

  remember(plan: GeneralPlan & { tasks: readonly TaskBrief[] }): void {
    for (const t of plan.tasks) {
      this.#byTask.delete(t.id);
      this.#byTask.set(t.id, plan);
    }
    while (this.#byTask.size > this.#max) {
      const oldest = this.#byTask.keys().next().value;
      if (oldest === undefined) break;
      this.#byTask.delete(oldest);
    }
  }

  get(taskId: string): GeneralPlan | undefined {
    return this.#byTask.get(taskId);
  }
}

/** Primero el almacén (`POST /plans`), después los planes de la mente. */
export function combinedPlanFor(store: PlanStoreReader, registry: PlanRegistry): PlanFor {
  const fromStore = planFromStore(store);
  return async (task) => (await fromStore(task)) ?? registry.get(task.id);
}
