import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter, NO_ATTRIBUTION_RULE, REVIEW_MODEL } from '../../../../src/core/adapters/claude-sdk/adapter.ts';
import { DEFAULT_CLAUDE_MODEL } from '../../../../src/core/adapters/claude-sdk/index.ts';
import type { HintedRunContext } from '../../../../src/core/brief/reasoning.ts';
import { buildReviewTask } from '../../../../src/core/orchestrator/fleet.ts';
import { agentConfigSchema, type TaskBrief } from '../../../../src/shared/index.ts';
import { collect, config, ctx, fakeQuery, loadJsonl, payload, task } from './helpers.ts';

/**
 * Issue 6: opciones que recibe el SDK según el rol (autor o revisor, por `isReviewTask`) y la dificultad, con la
 * fixture real `subagent-run.jsonl` como respuesta.
 */
const subagentRun = loadJsonl('subagent-run.jsonl');

const withDifficulty = (difficulty: TaskBrief['difficulty']): TaskBrief => ({ ...task, difficulty });
const reviewOf = (difficulty: TaskBrief['difficulty']) => buildReviewTask(withDifficulty(difficulty), ['codex'], 'Archivos: src/x.ts');

async function optionsFor(t: TaskBrief, hints: Partial<HintedRunContext> = {}, adapterOpts: Partial<ConstructorParameters<typeof ClaudeSdkAdapter>[0]> = {}) {
  const fake = fakeQuery(subagentRun);
  const events = await collect(new ClaudeSdkAdapter({ config, query: fake.query, ...adapterOpts }).run(t, { ...ctx(), ...hints }));
  const call = fake.calls[0];
  if (!call) throw new Error('el adaptador no llamó a query()');
  return { options: call.options, prompt: call.prompt, events };
}

describe('ClaudeSdkAdapter: esfuerzo y modelo por rol y dificultad', () => {
  const table: [string, () => TaskBrief, string, string][] = [
    ['autor low', () => withDifficulty('low'), DEFAULT_CLAUDE_MODEL, 'low'],
    ['autor medium', () => withDifficulty('medium'), DEFAULT_CLAUDE_MODEL, 'medium'],
    ['autor high', () => withDifficulty('high'), DEFAULT_CLAUDE_MODEL, 'high'],
    ['revisor de una tarea low', () => reviewOf('low'), REVIEW_MODEL, 'medium'],
    ['revisor de una tarea medium', () => reviewOf('medium'), REVIEW_MODEL, 'medium'],
    ['revisor de una tarea high', () => reviewOf('high'), DEFAULT_CLAUDE_MODEL, 'medium'],
  ];
  for (const [name, make, model, effort] of table) {
    it(`${name} → ${model}, esfuerzo ${effort}`, async () => {
      const { options, events } = await optionsFor(make());
      expect(options).toMatchObject({ model, effort });
      expect(payload(events, 'status')[0]?.detail).toContain(`${model} · ${name.startsWith('revisor') ? 'revisión' : 'autor'} · esfuerzo ${effort}`);
    });
  }

  it('el modelo de revisión es Sonnet 5.5', () => {
    expect(REVIEW_MODEL).toBe('claude-sonnet-5-5');
  });

  it('cada reintento sube un nivel; el autor no pasa de xhigh', async () => {
    expect((await optionsFor(withDifficulty('low'), { retries: 1 })).options.effort).toBe('medium');
    expect((await optionsFor(withDifficulty('medium'), { retries: 1 })).options.effort).toBe('high');
    expect((await optionsFor(withDifficulty('high'), { retries: 1 })).options.effort).toBe('xhigh');
    expect((await optionsFor(withDifficulty('low'), { retries: 9 })).options.effort).toBe('xhigh');
    expect((await optionsFor(reviewOf('low'), { retries: 1 })).options).toMatchObject({ model: REVIEW_MODEL, effort: 'high' });
  });

  it('reviewModel: null usa el modelo del agente también en revisiones; un effort fijo en extraOptions manda', async () => {
    expect((await optionsFor(reviewOf('low'), {}, { reviewModel: null })).options.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect((await optionsFor(reviewOf('low'), {}, { reviewModel: 'claude-haiku-5-5' })).options.model).toBe('claude-haiku-5-5');
    expect((await optionsFor(withDifficulty('high'), {}, { extraOptions: { effort: 'low' } })).options.effort).toBe('low');
    const sonnet = agentConfigSchema.parse({ ...config, model: 'claude-sonnet-5-5' });
    expect((await optionsFor(withDifficulty('high'), {}, { config: sonnet })).options.model).toBe('claude-sonnet-5-5');
  });

  it('prompt de sistema cacheable entre workers (excludeDynamicSections) y commits sin atribución', async () => {
    const { options } = await optionsFor(withDifficulty('low'));
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: NO_ATTRIBUTION_RULE, excludeDynamicSections: true });
    expect(options.settings).toEqual({ attribution: { commit: '', pr: '', sessionUrl: false } });
    expect(NO_ATTRIBUTION_RULE).toMatch(/Co-Authored-By/);
    // Un archivo de ajustes explícito se respeta tal cual (la regla del prompt sigue).
    expect((await optionsFor(withDifficulty('low'), {}, { extraOptions: { settings: 'C:\\ajustes.json' } })).options.settings).toBe('C:\\ajustes.json');
  });

  it('con AGENTS.md en el prompt de sistema, el encargo no pide leerlo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-razonamiento-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# Reglas\nUsa español.');
      const fake = fakeQuery(subagentRun);
      await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx({ worktreePath: dir })));
      const call = fake.calls[0];
      expect((call?.options.systemPrompt as { append?: string }).append).toContain('Usa español.');
      expect(call?.prompt).not.toContain('- `AGENTS.md`');
      expect(call?.prompt).toContain('- `.orq/PLAN.md` (plan general)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Sin reglas cargadas, el encargo sí lo pide.
    expect((await optionsFor(task)).prompt).toContain('- `AGENTS.md`');
  });
});

describe('ClaudeSdkAdapter: tope de gasto de la tarea (RunHints.budgetUsd)', () => {
  const budget = (budgetUsd: number) => agentConfigSchema.parse({ ...config, budgetUsd });

  it('pasa al SDK lo que le queda a la tarea si es menor que el presupuesto del agente', async () => {
    expect((await optionsFor(task, { budgetUsd: 0.3 })).options.maxBudgetUsd).toBe(0.3);
    expect((await optionsFor(task, { budgetUsd: 0.3 }, { config: budget(2), spentUsd: () => 1.9 })).options.maxBudgetUsd).toBeCloseTo(0.1, 9);
    expect((await optionsFor(task, { budgetUsd: 5 }, { config: budget(2) })).options.maxBudgetUsd).toBe(2);
  });

  it('no arranca si la tarea ya no tiene saldo', async () => {
    const fake = fakeQuery(subagentRun);
    const events = await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, { ...ctx(), budgetUsd: 0 } as HintedRunContext));
    expect(fake.calls).toHaveLength(0);
    expect(payload(events, 'error')).toEqual([{ code: 'quota_exhausted', message: 'Tope de gasto de la tarea agotado antes de empezar.' }]);
  });

  it('corta en curso al pasar el tope de la tarea y registra lo estimado', async () => {
    const fake = fakeQuery(subagentRun);
    const events = await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, { ...ctx(), budgetUsd: 0.05 } as HintedRunContext));
    expect(payload(events, 'error')).toEqual([{ code: 'quota_exhausted', message: 'Se superó el tope de gasto de la tarea: ~0.2214 USD de 0.0500 USD disponibles.' }]);
    expect(payload(events, 'usage')[0]?.costUsd).toBeGreaterThan(0.05);
    expect(fake.closed).toBe(true);
  });

  it('valores no válidos se ignoran', async () => {
    const { options } = await optionsFor(task, { budgetUsd: Number.NaN, retries: -3 });
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(options.effort).toBe('low');
  });
});
