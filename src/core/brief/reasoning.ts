import type { RunContext, TaskBrief } from '../../shared/index.ts';
import { isReviewTask, type RenderBriefOptions } from './render-brief.ts';

/**
 * Cómo razona cada ejecución (issue 6), el equivalente al `reasoningDefault` por propósito de Pollium:
 * - el rol sale de `isReviewTask` (autor o revisor) y el esfuerzo, de la dificultad: low → low, medium → medium,
 *   high → high; el revisor, `medium`;
 * - cada reintento sube un nivel en lugar de repetir igual;
 * - el Supervisor agrega a `RunContext` los reintentos previos y lo que la tarea aún puede gastar (`RunHints`).
 * Sin cambiar los contratos de tareas: lo usan los adaptadores de Claude y de Codex.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type TaskRole = 'author' | 'reviewer';

/** El revisor lee el diff y corre pruebas puntuales: no necesita más. */
export const REVIEW_EFFORT: Effort = 'medium';
/** Hasta dónde suben los reintentos si el adaptador no fija otro techo (`max` queda solo para quien lo pida). */
export const MAX_RETRY_EFFORT: Effort = 'xhigh';

export function taskRole(task: TaskBrief): TaskRole {
  return isReviewTask(task) ? 'reviewer' : 'author';
}

/** `effort` subido `steps` niveles, sin pasar de `max` (si ya estaba por encima, se queda donde está). */
export function bumpEffort(effort: Effort, steps: number, max: Effort = MAX_RETRY_EFFORT): Effort {
  const from = EFFORT_LEVELS.indexOf(effort);
  const top = Math.max(from, EFFORT_LEVELS.indexOf(max));
  const n = Number.isFinite(steps) ? Math.max(0, Math.floor(steps)) : 0;
  return EFFORT_LEVELS[Math.min(from + n, top)] ?? effort;
}

/** Esfuerzo de una ejecución según el rol, la dificultad y los reintentos previos. */
export function effortFor(task: TaskBrief, opts: { retries?: number; max?: Effort } = {}): Effort {
  const base: Effort = taskRole(task) === 'reviewer' ? REVIEW_EFFORT : task.difficulty;
  return bumpEffort(base, opts.retries ?? 0, opts.max);
}

/**
 * Datos de la ejecución que el Supervisor agrega a `RunContext` (propuesta: llevarlos al contrato de src/shared).
 * Un adaptador que no los conoce los ignora.
 */
export interface RunHints {
  /** Reintentos previos de la tarea en este ciclo (0 o ausente: primer intento). Cada uno sube el esfuerzo un nivel. */
  retries?: number;
  /** Lo que la tarea aún puede gastar, en USD (tope por tarea menos lo ya gastado). */
  budgetUsd?: number;
  /** Modo local: se trabaja en la carpeta del usuario. El encargo lleva la sección «Modo local» (`renderBrief`). */
  local?: { path: string };
}

export type HintedRunContext = RunContext & RunHints;

/** `RunHints` de un contexto, validados: un valor ausente, negativo o no finito no cuenta. */
export function runHints(ctx: RunContext): RunHints {
  const c = ctx as HintedRunContext;
  const hints: RunHints = {};
  if (typeof c.retries === 'number' && Number.isFinite(c.retries) && c.retries > 0) hints.retries = Math.floor(c.retries);
  if (typeof c.budgetUsd === 'number' && Number.isFinite(c.budgetUsd) && c.budgetUsd >= 0) hints.budgetUsd = c.budgetUsd;
  if (typeof c.local?.path === 'string' && c.local.path.trim()) hints.local = { path: c.local.path };
  return hints;
}

/** Opciones de `renderBrief` que salen del contexto (hoy, el modo local): las agregan los tres adaptadores. */
export function briefHints(ctx: RunContext): Pick<RenderBriefOptions, 'local'> {
  const { local } = runHints(ctx);
  return local ? { local } : {};
}
