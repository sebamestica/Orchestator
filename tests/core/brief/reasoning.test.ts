import { describe, expect, it } from 'vitest';
import { bumpEffort, effortFor, runHints, taskRole } from '../../../src/core/brief/reasoning.ts';
import { buildReviewTask } from '../../../src/core/orchestrator/fleet.ts';
import { taskBriefSchema, type RunContext } from '../../../src/shared/index.ts';

const task = taskBriefSchema.parse({
  id: 'adaptador-x', projectId: 'orquestador', title: 'Adaptador X', objective: 'Hacer X',
  ownedPaths: ['src/core/x/**'], dependsOn: [], acceptance: ['pruebas en verde'], difficulty: 'medium',
});
const ctx: RunContext = { worktreePath: 'C:\\w', env: {}, signal: new AbortController().signal, timeoutMs: 0 };

describe('razonamiento por rol y dificultad', () => {
  it('el rol sale de isReviewTask', () => {
    expect(taskRole(task)).toBe('author');
    expect(taskRole(buildReviewTask(task, ['codex'], 'diff'))).toBe('reviewer');
  });

  it('autor: esfuerzo = dificultad; revisor: medium', () => {
    expect(effortFor({ ...task, difficulty: 'low' })).toBe('low');
    expect(effortFor(task)).toBe('medium');
    expect(effortFor({ ...task, difficulty: 'high' })).toBe('high');
    expect(effortFor(buildReviewTask({ ...task, difficulty: 'high' }, ['codex'], 'diff'))).toBe('medium');
  });

  it('cada reintento sube un nivel, con techo (xhigh por defecto) y sin bajar nunca', () => {
    expect(bumpEffort('low', 1)).toBe('medium');
    expect(bumpEffort('low', 2)).toBe('high');
    expect(bumpEffort('high', 5)).toBe('xhigh');
    expect(bumpEffort('medium', 3, 'high')).toBe('high');
    expect(bumpEffort('max', 1, 'high')).toBe('max');
    expect(bumpEffort('low', -2)).toBe('low');
    expect(bumpEffort('low', Number.NaN)).toBe('low');
    expect(effortFor(task, { retries: 1, max: 'high' })).toBe('high');
  });

  it('runHints valida lo que agrega el Supervisor', () => {
    expect(runHints(ctx)).toEqual({});
    expect(runHints({ ...ctx, retries: 2.7, budgetUsd: 0.5 } as RunContext)).toEqual({ retries: 2, budgetUsd: 0.5 });
    expect(runHints({ ...ctx, retries: 0, budgetUsd: 0 } as RunContext)).toEqual({ budgetUsd: 0 });
    expect(runHints({ ...ctx, retries: Number.POSITIVE_INFINITY, budgetUsd: -1 } as RunContext)).toEqual({});
    expect(runHints({ ...ctx, retries: '3', budgetUsd: '1' } as unknown as RunContext)).toEqual({});
  });
});
