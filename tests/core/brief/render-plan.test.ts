import { describe, expect, it } from 'vitest';
import { MAX_PLAN_TEXT_CHARS, planTitle, renderPlanFile } from '../../../src/core/brief/render-plan.ts';
import { taskBriefSchema, type TaskBrief } from '../../../src/shared/index.ts';

function task(id: string, extra: Partial<TaskBrief> = {}): TaskBrief {
  return taskBriefSchema.parse({
    id, projectId: 'vetworld', title: `Tarea ${id}`, objective: `Implementar ${id}`, ownedPaths: [`src/${id}/**`],
    dependsOn: [], acceptance: ['npm test en verde'], difficulty: 'low', ...extra,
  });
}

describe('renderPlanFile (.orq/PLAN.md)', () => {
  const a = task('citas-form');
  const b = task('citas-pruebas', { dependsOn: ['citas-form'], ownedPaths: ['tests/citas/**', 'fixtures/citas/**'] });
  const plan = { id: 'plan-20261104-abc123', text: '1. Validar el formulario de citas.\n2. Pruebas del formulario.', tasks: [a, b] };

  it('plan general: texto del plan y tareas hermanas con id, título, rutas y dependencias; marca la propia', () => {
    const text = renderPlanFile(b, plan);
    expect(text.startsWith('# Plan general plan-20261104-abc123\n')).toBe(true);
    expect(text).toContain('Copia de solo lectura');
    expect(text).toContain('Tu plan de trabajo va en `.orq/PLAN-TAREA.md`');
    expect(text).toContain('Tu tarea: `citas-pruebas` — Tarea citas-pruebas.');
    expect(text).toContain('## Plan\n1. Validar el formulario de citas.\n2. Pruebas del formulario.');
    expect(text).toContain('- `citas-form` — Tarea citas-form · rutas: `src/citas-form/**` · depende de: ninguna');
    expect(text).toContain('- `citas-pruebas` — Tarea citas-pruebas **(tu tarea)** · rutas: `tests/citas/**`, `fixtures/citas/**` · depende de: `citas-form`');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('para la memoria: sin aviso ni marca «tu tarea» (la nota la comparten las tareas del plan)', () => {
    const text = renderPlanFile(b, plan, { forMemory: true });
    expect(text).not.toContain('Copia de solo lectura');
    expect(text).not.toContain('tu tarea');
    expect(text).toContain('- `citas-pruebas` — Tarea citas-pruebas · rutas:');
    expect(renderPlanFile(a, plan, { forMemory: true })).toBe(text);
  });

  it('tarea suelta: plan mínimo con objetivo, rutas, criterios y dependencias', () => {
    const text = renderPlanFile(b);
    expect(text.startsWith('# Plan de la tarea suelta citas-pruebas\n')).toBe(true);
    expect(text).toContain('el orquestador generó este plan mínimo a partir del encargo');
    expect(text).toContain('## Objetivo: Tarea citas-pruebas\nImplementar citas-pruebas');
    expect(text).toContain('## Rutas propias\n- `tests/citas/**`\n- `fixtures/citas/**`');
    expect(text).toContain('## Criterios de aceptación\n- npm test en verde');
    expect(text).toContain('## Dependencias\n- `citas-form` (integrada antes de empezar)');
    expect(renderPlanFile(a)).toContain('## Dependencias\nNinguna.');
  });

  it('un plan sin id ni tareas lista solo la propia; recorta un texto enorme y tacha secretos', () => {
    const text = renderPlanFile(a, { text: `Usa sk-ant-api03-${'z'.repeat(30)} y luego ${'x'.repeat(MAX_PLAN_TEXT_CHARS + 500)}` });
    expect(text.startsWith('# Plan general\n')).toBe(true);
    expect(text).not.toContain('sk-ant-api03');
    expect(text).toContain('[REDACTADO]');
    expect(text).toContain(`(plan recortado a ${MAX_PLAN_TEXT_CHARS} caracteres)`);
    expect(text).toContain('- `citas-form` — Tarea citas-form **(tu tarea)**');
    expect(text.length).toBeLessThan(MAX_PLAN_TEXT_CHARS + 2_000);
  });

  it('título de la nota de memoria', () => {
    expect(planTitle(a, plan)).toBe('Plan plan-20261104-abc123');
    expect(planTitle(a)).toBe('Plan de la tarea citas-form: Tarea citas-form');
  });
});
