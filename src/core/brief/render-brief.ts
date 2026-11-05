import type { Handoff, TaskBrief } from '../../shared/index.ts';
import { PLAN_FILES, redactSecrets } from '../../shared/index.ts';

export interface RenderBriefOptions {
  /** Extracto de memoria (Obsidian) ya recortado por MemoryStore.buildContext. */
  memoryContext?: string;
  /** Rutas de reglas del repo que el agente debe leer primero. */
  rulesFiles?: readonly string[];
  /** Modo local: se trabaja directamente en la carpeta del usuario (sin worktree, ramas ni commits). */
  local?: { path: string };
  /**
   * Las reglas de la raíz del repo (`AGENTS.md`, `CLAUDE.md`) ya le llegan al agente por otra vía (el prompt de
   * sistema de Claude, la carga propia de Codex): «Lee primero» no las repite.
   */
  rulesInSystemPrompt?: boolean;
}

/** Archivos de reglas de la raíz que Claude (prompt de sistema) y Codex (carga propia) ya tienen. */
const ROOT_RULES: ReadonlySet<string> = new Set(['agents.md', 'claude.md']);
const isRootRules = (file: string) => ROOT_RULES.has(file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').toLowerCase());

/** Reglas del modo local (carpeta del usuario): van al principio, antes del objetivo. */
export function localModeSection(path: string): string[] {
  return [
    '## Modo local (sin worktree)',
    `Trabajas directamente en la carpeta del usuario (\`${path}\`), no en una copia: lo que cambies queda guardado ahí al instante.`,
    '- No hagas commits ni ramas, y no uses `git init`, `git stash`, `git reset`, `git checkout`, `git switch`, `git restore` ni `git clean`: la carpeta es del usuario y en modo local Berland no confirma nada.',
    '- Toca solo tus rutas propias. No borres, muevas ni reformatees archivos fuera de ellas.',
    '- `.orq/` es la carpeta de trabajo de Berland: no la borres.',
    '',
  ];
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
    // El objetivo de la revisión ya trae el plan del autor, los criterios y las rutas: no se reenvía `.orq/PLAN.md`.
    lines.push(
      '## Plan de la tarea revisada',
      `El plan del autor (\`${PLAN_FILES.taskPlan}\`) va en el objetivo: compáralo con el trabajo. No modifiques \`${PLAN_FILES.taskPlan}\` ni \`${PLAN_FILES.plan}\`.`,
      '',
    );
  } else {
    lines.push(...implementationPlanSection());
  }
  if (opts.local) lines.push(...localModeSection(opts.local.path));
  if (handoff) {
    lines.push(
      '## Continuación de otro agente',
      `Esta tarea la empezó \`${handoff.fromAgent}\` y se detuvo por: ${handoff.reason}. ${opts.local ? 'Trabajas en la misma carpeta.' : 'Trabajas en el mismo worktree.'}`,
      opts.local
        ? 'Antes de seguir: lee `.orq/HANDOFF.md` si existe, revisa los archivos de tus rutas propias y continúa desde ahí sin rehacer lo que ya funciona.'
        : 'Antes de seguir: lee `.orq/HANDOFF.md` si existe, revisa `git status`, `git diff` y `git log` de esta rama, y continúa desde ahí sin rehacer lo que ya funciona.',
    );
    if (!review) {
      lines.push(`Lee \`${PLAN_FILES.taskPlan}\` del agente anterior y sigue desde el primer paso sin marcar (si no existe, escríbelo antes de seguir).`);
    }
    lines.push('', 'Resumen del agente anterior:', handoff.partialSummary || '(sin resumen)', '');
  }
  lines.push('## Objetivo', task.objective, '');
  lines.push('## Rutas que puedes modificar (solo estas)', ...task.ownedPaths.map((p) => `- \`${p}\``), '');
  lines.push('## Criterios de aceptación', ...task.acceptance.map((a) => `- [ ] ${a}`), '');
  const rules = (opts.rulesFiles ?? ['AGENTS.md']).filter((r) => !(opts.rulesInSystemPrompt && isRootRules(r)));
  const reads = [
    ...(review ? [] : [`- \`${PLAN_FILES.plan}\` (plan general)`]),
    ...rules.map((r) => `- \`${r}\``),
    ...task.skillRefs.map((ref) => `- skill: \`${ref}\``),
    ...task.contextRefs.map((ref) => `- memoria: \`${ref}\``),
  ];
  if (reads.length) lines.push('## Lee primero', ...reads, '');
  if (opts.memoryContext?.trim()) lines.push('## Contexto de memoria', opts.memoryContext.trim(), '');
  if (review) {
    // El revisor solo entrega un veredicto: un informe largo es salida (la parte cara) que nadie lee.
    lines.push('## Al terminar', 'Responde breve: qué comprobaste y, si algo falla, qué y cómo corregirlo. La última línea es el veredicto en JSON.');
  } else {
    lines.push(
      '## Al terminar',
      `Entrega un informe con: pasos de \`${PLAN_FILES.taskPlan}\` hechos y pendientes; archivos cambiados; comandos ejecutados y su salida real resumida; pruebas aprobadas y fallidas; lo no ejecutado; cambios propuestos fuera de tus rutas; bloqueos.`,
      'Si te quedas sin cupo o sin tiempo: escribe `.orq/HANDOFF.md` con lo hecho, lo pendiente y lo probado, para que otro agente continúe.',
    );
  }
  return redactSecrets(lines.join('\n'));
}
