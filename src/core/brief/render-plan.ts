import type { TaskBrief } from '../../shared/index.ts';
import { PLAN_FILES, redactSecrets } from '../../shared/index.ts';

/** Plan general del que sale una tarea. La flota lo escribe en `.orq/PLAN.md` antes de cada intento. */
export interface GeneralPlan {
  /** Id del plan en el almacén (`plan-…`). Sin él, la nota de memoria usa el id de la tarea. */
  id?: string;
  /** Texto del plan tal como lo dio el usuario (`POST /plans`) o la mente (`crear_tareas`). */
  text: string;
  /** Tareas del plan, incluida la propia, en su orden. */
  tasks?: readonly TaskBrief[];
}

export interface RenderPlanOptions {
  /** Texto para la nota de memoria (compartida por las tareas del plan): sin el aviso ni la marca «tu tarea». */
  forMemory?: boolean;
}

/** Tope del texto del plan dentro de `.orq/PLAN.md` (el de `POST /plans` es de 20 000 caracteres). */
export const MAX_PLAN_TEXT_CHARS = 30_000;
/** Tareas hermanas que se listan como mucho. */
export const MAX_PLAN_TASKS = 100;
const MAX_PATHS_PER_TASK = 10;

const NOTICE = [
  `> Copia de solo lectura: la escribe el orquestador antes de cada intento. No la edites.`,
  `> Tu plan de trabajo va en \`${PLAN_FILES.taskPlan}\`; el encargo completo, en \`${PLAN_FILES.brief}\`.`,
].join('\n');

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const code = (text: string) => `\`${oneLine(text).replace(/`/g, "'")}\``;

function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…\n\n(plan recortado a ${max} caracteres)`;
}

function list(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).map(code).join(', ');
  return items.length > max ? `${shown} y ${items.length - max} más` : shown;
}

function taskLine(t: TaskBrief, currentId: string | undefined): string {
  const mine = t.id === currentId ? ' **(tu tarea)**' : '';
  const deps = t.dependsOn.length ? list(t.dependsOn, MAX_PLAN_TASKS) : 'ninguna';
  return `- ${code(t.id)} — ${oneLine(t.title)}${mine} · rutas: ${list(t.ownedPaths, MAX_PATHS_PER_TASK)} · depende de: ${deps}`;
}

/**
 * Texto de `.orq/PLAN.md`: el plan general (texto del plan y tareas hermanas con id, título, rutas propias y
 * dependencias) o, para una tarea suelta, un plan mínimo generado del encargo (objetivo, rutas, criterios y
 * dependencias). Tachado con `redactSecrets`.
 */
export function renderPlanFile(task: TaskBrief, plan?: GeneralPlan, opts: RenderPlanOptions = {}): string {
  const lines = plan ? generalPlan(task, plan, opts) : minimalPlan(task, opts);
  return `${redactSecrets(lines.join('\n')).trimEnd()}\n`;
}

/** Título de la nota de memoria del plan. */
export function planTitle(task: TaskBrief, plan?: GeneralPlan): string {
  return plan?.id ? `Plan ${plan.id}` : `Plan de la tarea ${task.id}: ${oneLine(task.title)}`.slice(0, 200);
}

function generalPlan(task: TaskBrief, plan: GeneralPlan, opts: RenderPlanOptions): string[] {
  const lines = [`# Plan general${plan.id ? ` ${plan.id}` : ''}`, ''];
  if (!opts.forMemory) lines.push(NOTICE, '', `Tu tarea: ${code(task.id)} — ${oneLine(task.title)}.`, '');
  lines.push('## Plan', head(plan.text.trim() || '(sin texto)', MAX_PLAN_TEXT_CHARS), '');
  const tasks = plan.tasks?.length ? plan.tasks : [task];
  lines.push('## Tareas del plan', ...tasks.slice(0, MAX_PLAN_TASKS).map((t) => taskLine(t, opts.forMemory ? undefined : task.id)));
  if (tasks.length > MAX_PLAN_TASKS) lines.push(`- … y ${tasks.length - MAX_PLAN_TASKS} tareas más`);
  return lines;
}

function minimalPlan(task: TaskBrief, opts: RenderPlanOptions): string[] {
  const lines = [`# Plan de la tarea suelta ${task.id}`, ''];
  if (!opts.forMemory) lines.push(NOTICE, '');
  lines.push(
    'Esta tarea no viene de un plan: el orquestador generó este plan mínimo a partir del encargo.',
    '',
    `## Objetivo: ${oneLine(task.title)}`,
    head(task.objective.trim(), MAX_PLAN_TEXT_CHARS),
    '',
    '## Rutas propias',
    ...task.ownedPaths.map((p) => `- ${code(p)}`),
    '',
    '## Criterios de aceptación',
    ...task.acceptance.map((a) => `- ${oneLine(a)}`),
    '',
    '## Dependencias',
    ...(task.dependsOn.length ? task.dependsOn.map((d) => `- ${code(d)} (integrada antes de empezar)`) : ['Ninguna.']),
  );
  return lines;
}
