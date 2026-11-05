import { describe, expect, it } from 'vitest';
import { implementationPlanSection, isReviewTask, renderBrief } from '../../../src/core/brief/render-brief.ts';
import { buildReviewTask } from '../../../src/core/orchestrator/fleet.ts';
import { PLAN_FILES, taskBriefSchema, type Handoff } from '../../../src/shared/index.ts';

const task = taskBriefSchema.parse({
  id: 'adaptador-x', projectId: 'orquestador', title: 'Adaptador X', objective: 'Hacer X',
  ownedPaths: ['src/core/x/**'], dependsOn: [], acceptance: ['pruebas en verde'], difficulty: 'medium',
});

const handoff: Handoff = {
  taskId: 'adaptador-x', fromAgent: 'codex', toAgent: 'claude-1', reason: 'quota_exhausted',
  worktreePath: 'C:\\w', partialSummary: 'avancé el parser', at: '2026-11-04T12:00:00Z',
};

const sections = (text: string) => text.split('\n').filter((l) => l.startsWith('## '));

describe('renderBrief: plan de implementación obligatorio', () => {
  it('la sección del plan va al principio, antes del objetivo, con las cuatro reglas', () => {
    const text = renderBrief(task);
    expect(sections(text)[0]).toBe('## Plan de implementación (obligatorio)');
    const plan = text.slice(text.indexOf('## Plan de implementación'), text.indexOf('## Objetivo'));
    expect(plan).toContain(`Antes de modificar código, escribe \`${PLAN_FILES.taskPlan}\` con pasos numerados \`- [ ]\``);
    expect(plan).toMatch(/archivos que vas a crear o tocar, las pruebas que vas a escribir y los riesgos/);
    expect(plan).toContain('Marca `- [x]` cada paso al terminarlo.');
    expect(plan).toContain('Si pierdes el hilo, se corta la sesión o vienes de un traspaso, relee `.orq/PLAN.md`, `.orq/PLAN-TAREA.md` y `.orq/BRIEF.md` antes de seguir.');
    expect(plan).toContain('El informe final dice qué pasos quedaron hechos');
    expect(implementationPlanSection().join('\n').trimEnd()).toBe(plan.trimEnd());
  });

  it('«Lee primero» empieza por .orq/PLAN.md y el informe pide los pasos hechos', () => {
    const text = renderBrief(task, undefined, { rulesFiles: ['AGENTS.md', 'docs/plan/F5-INTERFAZ.md'] });
    const read = text.slice(text.indexOf('## Lee primero')).split('\n').slice(1, 4);
    expect(read).toEqual(['- `.orq/PLAN.md` (plan general)', '- `AGENTS.md`', '- `docs/plan/F5-INTERFAZ.md`']);
    expect(text).toMatch(/## Al terminar\nEntrega un informe con: pasos de `\.orq\/PLAN-TAREA\.md` hechos y pendientes;/);
  });

  it('en un traspaso manda leer el PLAN-TAREA.md del agente anterior y seguir desde el primer paso sin marcar', () => {
    const text = renderBrief(task, handoff);
    expect(sections(text).slice(0, 2)).toEqual(['## Plan de implementación (obligatorio)', '## Continuación de otro agente']);
    const cont = text.slice(text.indexOf('## Continuación'), text.indexOf('## Objetivo'));
    expect(cont).toContain('Lee `.orq/PLAN-TAREA.md` del agente anterior y sigue desde el primer paso sin marcar');
    expect(cont).toContain('avancé el parser');
  });

  it('el encargo de revisión no pide escribir PLAN-TAREA.md (es el del autor): pide compararlo', () => {
    const review = buildReviewTask(task, ['codex'], 'Archivos: src/core/x/a.ts', '- [x] 1. parser\n- [ ] 2. pruebas');
    expect(isReviewTask(review)).toBe(true);
    expect(isReviewTask(task)).toBe(false);
    const text = renderBrief(review, { ...handoff, taskId: review.id });
    expect(text).not.toContain('Plan de implementación (obligatorio)');
    expect(text).not.toContain('sigue desde el primer paso sin marcar');
    expect(sections(text)[0]).toBe('## Plan de la tarea revisada');
    expect(text).toContain('No modifiques `.orq/PLAN-TAREA.md` ni `.orq/PLAN.md`.');
    expect(text).toContain('- [ ] 2. pruebas'); // el plan del autor va en el objetivo
  });

  it('la revisión no reenvía lecturas: sin `.orq/PLAN.md` en «Lee primero», informe breve y sin HANDOFF', () => {
    const review = buildReviewTask(task, ['codex'], 'Archivos: src/core/x/a.ts', '- [x] 1. parser');
    const text = renderBrief(review);
    expect(text).not.toContain('- `.orq/PLAN.md` (plan general)');
    expect(text).toContain('## Lee primero\n- `AGENTS.md`');
    expect(text).toContain('## Al terminar\nResponde breve: qué comprobaste');
    expect(text).not.toContain('HANDOFF.md');
    // Con las reglas ya en el prompt de sistema no queda nada que leer: la sección desaparece.
    expect(sections(renderBrief(review, undefined, { rulesInSystemPrompt: true }))).not.toContain('## Lee primero');
  });

  it('con las reglas en el prompt de sistema no pide leer AGENTS.md ni CLAUDE.md; sí otras reglas, skills y memoria', () => {
    const t = { ...task, skillRefs: ['C:\\hub\\skill\\SKILL.md'], contextRefs: ['Proyectos/x/nota.md'] };
    const text = renderBrief(t, undefined, { rulesFiles: ['AGENTS.md', './CLAUDE.md', 'docs/plan/F5.md'], rulesInSystemPrompt: true });
    const read = text.slice(text.indexOf('## Lee primero'), text.indexOf('## Al terminar')).trim().split('\n');
    expect(read).toEqual([
      '## Lee primero',
      '- `.orq/PLAN.md` (plan general)',
      '- `docs/plan/F5.md`',
      '- skill: `C:\\hub\\skill\\SKILL.md`',
      '- memoria: `Proyectos/x/nota.md`',
    ]);
    expect(renderBrief(t)).toContain('- `AGENTS.md`');
  });

  it('una tarea con rutas dentro y fuera de .orq sí es de autor', () => {
    expect(isReviewTask({ ...task, ownedPaths: ['.orq/NOTAS.md', 'src/a.ts'] })).toBe(false);
    expect(isReviewTask({ ...task, ownedPaths: ['./.orq/REVISION.md'] })).toBe(true);
    expect(isReviewTask({ ...task, ownedPaths: ['.orq\\REVISION.md'] })).toBe(true);
  });
});
