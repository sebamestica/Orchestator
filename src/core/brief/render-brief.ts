import type { Handoff, TaskBrief } from '../../shared/index.ts';
import { PLAN_FILES, redactSecrets } from '../../shared/index.ts';

export interface RenderBriefOptions {
  /** Extracto de memoria (Obsidian) ya recortado por MemoryStore.buildContext. */
  memoryContext?: string;
  /** Rutas de reglas del repo que el agente debe leer primero. */
  rulesFiles?: readonly string[];
}

/**
 * Encargo que no toca el proyecto (p. ej. la revisión, con `ownedPaths: ['.orq/REVISION.md']`): no escribe su propio
 * `.orq/PLAN-TAREA.md`, que es el del autor. Los adaptadores reciben solo la tarea, así que se distingue por sus rutas.
 */
export function isReviewTask(task: TaskBrief): boolean {
  return task.ownedPaths.length > 0 && task.ownedPaths.every((p) => p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').startsWith('.orq/'));
}

/** Sección obligatoria al principio de cada encargo de un autor (regla del usuario, F5 §1.10). */
export function implementationPlanSection(): string[] {
  return [
    '## Plan de implementación (obligatorio)',
    `1. Antes de modificar código, escribe \`${PLAN_FILES.taskPlan}\` con pasos numerados \`- [ ]\`, los archivos que vas a crear o tocar, las pruebas que vas a escribir y los riesgos.`,
    '2. Marca `- [x]` cada paso al terminarlo.',
    `3. Si pierdes el hilo, se corta la sesión o vienes de un traspaso, relee \`${PLAN_FILES.plan}\`, \`${PLAN_FILES.taskPlan}\` y \`${PLAN_FILES.brief}\` antes de seguir.`,
    '4. El informe final dice qué pasos quedaron hechos y cuáles no.',
    `\`${PLAN_FILES.plan}\` es el plan general del que sale esta tarea (solo lectura). \`.orq/\` no entra en el commit.`,
    '',
  ];
}

/** Convierte un encargo en el texto que recibe cualquier agente. Mismo formato para Claude, Codex y agy. */
export function renderBrief(task: TaskBrief, handoff?: Handoff, opts: RenderBriefOptions = {}): string {
  const review = isReviewTask(task);
  const lines: string[] = [];
  lines.push(`# Tarea ${task.id}: ${task.title}`, '');
  if (review) {
    lines.push(
      '## Plan de la tarea revisada',
      `Compara el trabajo con el plan del autor (\`${PLAN_FILES.taskPlan}\`) y con el plan general (\`${PLAN_FILES.plan}\`). No modifiques esos archivos.`,
      '',
    );
  } else {
    lines.push(...implementationPlanSection());
  }
  if (handoff) {
    lines.push(
      '## Continuación de otro agente',
      `Esta tarea la empezó \`${handoff.fromAgent}\` y se detuvo por: ${handoff.reason}. Trabajas en el mismo worktree.`,
      'Antes de seguir: lee `.orq/HANDOFF.md` si existe, revisa `git status`, `git diff` y `git log` de esta rama, y continúa desde ahí sin rehacer lo que ya funciona.',
    );
    if (!review) {
      lines.push(`Lee \`${PLAN_FILES.taskPlan}\` del agente anterior y sigue desde el primer paso sin marcar (si no existe, escríbelo antes de seguir).`);
    }
    lines.push('', 'Resumen del agente anterior:', handoff.partialSummary || '(sin resumen)', '');
  }
  lines.push('## Objetivo', task.objective, '');
  lines.push('## Rutas que puedes modificar (solo estas)', ...task.ownedPaths.map((p) => `- \`${p}\``), '');
  lines.push('## Criterios de aceptación', ...task.acceptance.map((a) => `- [ ] ${a}`), '');
  const rules = opts.rulesFiles ?? ['AGENTS.md'];
  lines.push('## Lee primero', `- \`${PLAN_FILES.plan}\` (plan general)`, ...rules.map((r) => `- \`${r}\``));
  for (const ref of task.skillRefs) lines.push(`- skill: \`${ref}\``);
  for (const ref of task.contextRefs) lines.push(`- memoria: \`${ref}\``);
  lines.push('');
  if (opts.memoryContext?.trim()) lines.push('## Contexto de memoria', opts.memoryContext.trim(), '');
  lines.push(
    '## Al terminar',
    review
      ? 'Entrega un informe con: archivos cambiados; comandos ejecutados y su salida real resumida; pruebas aprobadas y fallidas; lo no ejecutado; cambios propuestos fuera de tus rutas; bloqueos.'
      : `Entrega un informe con: pasos de \`${PLAN_FILES.taskPlan}\` hechos y pendientes; archivos cambiados; comandos ejecutados y su salida real resumida; pruebas aprobadas y fallidas; lo no ejecutado; cambios propuestos fuera de tus rutas; bloqueos.`,
    'Si te quedas sin cupo o sin tiempo: escribe `.orq/HANDOFF.md` con lo hecho, lo pendiente y lo probado, para que otro agente continúe.',
  );
  return redactSecrets(lines.join('\n'));
}
