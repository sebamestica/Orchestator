import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Router, RoutingError } from '../../../src/core/orchestrator/router.ts';
import { parseAgyUsage } from '../../../src/core/quota/agy.ts';
import { agentConfigSchema } from '../../../src/shared/index.ts';
import { agents, agyFixtureQuota, FakeQuota, task } from './fakes.ts';

const all = [agents.claude1, agents.claude2, agents.codex, agents.agy];

describe('Router: dificultad', () => {
  it('dificultad alta → Claude aunque se sugiera Codex', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.9)] });
    const decision = await router.route(task('dura', { difficulty: 'high', suggestedAgent: 'codex' }));
    expect(router.isClaude(decision.agentId)).toBe(true);
    expect(decision.warnings.join(' ')).toMatch(/Se ignora el agente sugerido codex/);
  });

  it('dificultad alta respeta un Claude sugerido', async () => {
    const router = new Router({ agents: all });
    expect((await router.route(task('dura', { difficulty: 'high', suggestedAgent: 'claude-2' }))).agentId).toBe('claude-2');
  });

  it('sin Claude disponible para una tarea difícil, lanza RoutingError', async () => {
    const router = new Router({ agents: [agents.codex] });
    await expect(router.route(task('dura', { difficulty: 'high' }))).rejects.toThrow(RoutingError);
  });
});

describe('Router: umbral de cupo', () => {
  it.each([
    [0.5, 'codex'],
    [0.2, 'codex'], // justo en el piso: se permite (≥)
    [0.19, 'claude-1'],
    [0, 'claude-1'],
  ])('Codex con %d de cupo → %s', async (fraction, expected) => {
    const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', fraction)] });
    const decision = await router.route(task('tarea'));
    expect(decision.agentId).toBe(expected);
    if (expected !== 'codex') expect(decision.warnings.join(' ')).toMatch(/codex descartado: cupo 19 %|codex descartado: cupo 0 %/);
  });

  it('usa el quotaFloor de cada agente y, si falta, el piso por defecto', async () => {
    const strictCodex = agentConfigSchema.parse({ ...agents.codex, quotaFloor: 0.5 });
    const router = new Router({ agents: [agents.claude1, strictCodex, agents.agy], quotas: [new FakeQuota('codex', 0.4), new FakeQuota('agy', 0.4)] });
    expect((await router.checkQuota('codex')).allowed).toBe(false);
    expect((await router.checkQuota('agy')).allowed).toBe(true);
    expect((await router.route(task('tarea'))).agentId).toBe('agy');
  });

  it('cupo desconocido, sin proveedor o con error de lectura → permitido con advertencia (tachada)', async () => {
    const failing = new FakeQuota('agy', 0.9);
    failing.failWith = 'HTTP 500 con Bearer abcdefghijklmnopqrstuvwxyz0123';
    const router = new Router({ agents: [agents.claude1, agents.codex, agents.agy], quotas: [new FakeQuota('codex', null), failing] });
    const codex = await router.checkQuota('codex');
    expect(codex).toMatchObject({ allowed: true, fraction: null });
    expect(codex.warnings.join(' ')).toMatch(/cupo desconocido; se permite con advertencia/);
    const agy = await router.checkQuota('agy');
    expect(agy.allowed).toBe(true);
    expect(agy.warnings.join(' ')).toMatch(/no se pudo leer el cupo/);
    expect(agy.warnings.join(' ')).not.toContain('abcdefghijklmnopqrstuvwxyz0123');

    const bare = new Router({ agents: [agents.claude1, agents.codex] });
    const decision = await bare.route(task('tarea'));
    expect(decision.agentId).toBe('codex');
    expect(decision.warnings.join(' ')).toMatch(/sin proveedor de cupo; se permite con advertencia/);
  });

  it('usa el cupo real de agy grabado en fixtures (≈ 99,9 %)', async () => {
    const router = new Router({ agents: [agents.claude1, agents.agy], quotas: [await agyFixtureQuota()] });
    const check = await router.checkQuota('agy');
    expect(check.allowed).toBe(true);
    expect(check.fraction).toBeGreaterThan(0.99);
    expect((await router.route(task('tarea'))).agentId).toBe('agy');
  });

  it('agy decide con el grupo de su modelo: Claude/GPT agotado no frena a un agy en Gemini', async () => {
    const raw = JSON.parse(await readFile(new URL('../../../fixtures/agy/usage.json', import.meta.url), 'utf8')) as { command: { data: { groups: { name: string; buckets: { remaining_fraction: number }[] }[] } } };
    for (const group of raw.command.data.groups) {
      for (const bucket of group.buckets) bucket.remaining_fraction = group.name === 'Gemini Models' ? 1 : 0.05;
    }
    const routerFor = (model: string) => {
      const agy = agentConfigSchema.parse({ ...agents.agy, model });
      const snapshot = parseAgyUsage(raw, 'agy', new Date().toISOString(), { model });
      return new Router({ agents: [agents.claude1, agy], quotas: [{ agentId: 'agy', read: async () => snapshot }] });
    };

    const gemini = routerFor('gemini-3.8-flash-high');
    expect(await gemini.checkQuota('agy')).toMatchObject({ allowed: true, fraction: 1 });
    expect((await gemini.route(task('tarea'))).agentId).toBe('agy');

    const claude = routerFor('claude-sonnet-4-6');
    expect(await claude.checkQuota('agy')).toMatchObject({ allowed: false, fraction: 0.05 });
    const decision = await claude.route(task('tarea'));
    expect(decision.agentId).toBe('claude-1');
    expect(decision.warnings.join(' ')).toMatch(/agy descartado/);
  });

  it('reutiliza la lectura de cupo durante quotaCacheMs y la vuelve a leer al invalidarla', async () => {
    let now = 0;
    const quota = new FakeQuota('codex', 0.9);
    const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [quota], quotaCacheMs: 1_000, now: () => now });
    await router.checkQuota('codex');
    await router.checkQuota('codex');
    expect(quota.reads).toBe(1);
    now = 1_500;
    await router.checkQuota('codex');
    expect(quota.reads).toBe(2);
    router.invalidateQuota('codex');
    quota.fraction = 0.1;
    expect((await router.checkQuota('codex')).allowed).toBe(false);
    expect(quota.reads).toBe(3);
  });

  it('tras quota_exhausted bloquea al agente hasta una lectura nueva ≥ piso o el fin del enfriamiento', async () => {
    let now = Date.parse('2026-11-01T12:00:00Z');
    const quota = new FakeQuota('codex', 0.9);
    quota.stale = true; // lectura antigua que aún dice 90 %
    quota.takenAt = () => new Date(now - 60_000).toISOString();
    const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [quota], exhaustedCooldownMs: 10 * 60_000, quotaCacheMs: 0, now: () => now });
    router.markExhausted('codex');
    expect((await router.checkQuota('codex')).allowed).toBe(false);
    expect((await router.route(task('tarea'))).agentId).toBe('claude-1');

    quota.stale = false;
    quota.takenAt = () => new Date(now).toISOString(); // lectura posterior al agotamiento
    now += 1_000;
    expect((await router.checkQuota('codex')).allowed).toBe(true);

    router.markExhausted('codex');
    quota.takenAt = () => new Date(now - 1).toISOString();
    expect((await router.checkQuota('codex')).allowed).toBe(false);
    now += 10 * 60_000; // fin del enfriamiento: vuelve la regla normal
    expect((await router.checkQuota('codex')).allowed).toBe(true);

    const bare = new Router({ agents: [agents.claude1, agents.agy], now: () => now, exhaustedCooldownMs: 1_000 });
    bare.markExhausted('agy');
    expect((await bare.checkQuota('agy')).allowed).toBe(false);
    now += 1_000;
    expect((await bare.checkQuota('agy')).allowed).toBe(true);
  });
});

describe('Router: reparto de carga', () => {
  it('reparte las tareas difíciles entre las instancias de Claude por carga y turno', async () => {
    const router = new Router({ agents: [agents.claude1, agents.claude2, agents.codex] });
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) picks.push((await router.route(task(`d${i}`, { difficulty: 'high' }))).agentId);
    expect(picks).toEqual(['claude-1', 'claude-2', 'claude-1', 'claude-2']);
    expect([router.load('claude-1'), router.load('claude-2')]).toEqual([2, 2]);
    router.release('claude-2');
    expect(router.pickClaude().agentId).toBe('claude-2'); // la menos cargada
    expect(router.pickClaude({ exclude: ['claude-2'] }).agentId).toBe('claude-1');
  });

  it('un CLI ocupado (1 tarea por defecto) deja pasar al siguiente y luego a Claude', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.5)] });
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) picks.push((await router.route(task(`t${i}`))).agentId);
    expect(picks).toEqual(['codex', 'agy', 'claude-1']); // más cupo primero
    router.release('agy');
    expect((await router.route(task('t3'))).agentId).toBe('agy');
  });

  it('un agente sugerido con cupo se respeta; sin cupo, se elige otro con aviso', async () => {
    const quotas = [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.1)];
    const router = new Router({ agents: all, quotas });
    expect((await router.route(task('ta', { suggestedAgent: 'codex' }))).agentId).toBe('codex');
    router.release('codex');
    const decision = await router.route(task('tb', { suggestedAgent: 'agy' }));
    expect(decision.agentId).toBe('codex');
    expect(decision.warnings.join(' ')).toMatch(/agy no tiene cupo/);
  });

  it('ignora agentes deshabilitados y modelos por API (no editan código)', async () => {
    const disabledCodex = agentConfigSchema.parse({ ...agents.codex, enabled: false });
    const router = new Router({ agents: [agents.api, disabledCodex, agents.claude1] });
    const decision = await router.route(task('tarea', { suggestedAgent: 'openrouter' }));
    expect(decision.agentId).toBe('claude-1');
    expect(decision.warnings.join(' ')).toMatch(/openrouter no está disponible/);
  });
});

describe('Router: asignaciones simultáneas (hallazgo 3 de Codex)', () => {
  it('dos route() a la vez no superan el límite de un CLI', async () => {
    const router = new Router({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.9)] });
    const picks = (await Promise.all([router.route(task('ta')), router.route(task('tb'))])).map((d) => d.agentId);
    expect(picks.sort()).toEqual(['claude-1', 'codex']);
    expect(router.load('codex')).toBe(1);
  });

  it('cinco route() a la vez reparten entre Codex, agy y Claude sin pasarse', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.8)] });
    const picks = (await Promise.all(['t1', 't2', 't3', 't4', 't5'].map((id) => router.route(task(id))))).map((d) => d.agentId);
    expect(picks.filter((p) => p === 'codex')).toHaveLength(1);
    expect(picks.filter((p) => p === 'agy')).toHaveLength(1);
    expect(router.load('codex')).toBe(1);
    expect(router.load('agy')).toBe(1);
  });

  it('dos chooseReviewer() a la vez no dan el mismo CLI dos veces si hay otro candidato', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.1)] });
    const picks = (await Promise.all([router.chooseReviewer(task('ta'), 'claude-1'), router.chooseReviewer(task('tb'), 'claude-1')])).map((d) => d.agentId);
    expect(picks.sort()).toEqual(['claude-2', 'codex']);
    expect(router.load('codex')).toBe(1);
  });
});

describe('Router: revisor', () => {
  it.each([
    ['todos', all, [0.9, 0.9]],
    ['solo Claude', [agents.claude1, agents.claude2], [0.9, 0.9]],
    ['Claude y CLI sin cupo', all, [0.05, 0.05]],
    ['un Claude y Codex', [agents.claude1, agents.codex], [0.9, 0.9]],
  ] as const)('nunca devuelve al autor (%s), aunque sea el menos cargado', async (_name, configs, [codexQ, agyQ]) => {
    const router = new Router({ agents: configs, quotas: [new FakeQuota('codex', codexQ), new FakeQuota('agy', agyQ)] });
    for (const author of configs.map((a) => a.id)) {
      // Carga a todos menos al autor: un reparto por carga lo elegiría a él.
      for (const other of configs) if (other.id !== author) router.acquire(other.id);
      for (let i = 0; i < 3; i++) {
        const reviewer = await router.chooseReviewer(task('tarea'), author);
        expect(reviewer.agentId).not.toBe(author);
        router.release(reviewer.agentId);
      }
      for (const other of configs) if (other.id !== author) router.release(other.id);
    }
  });

  it('autor Claude → revisa Codex/agy con cupo; autor Codex → revisa Claude', async () => {
    const router = new Router({ agents: all, quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.1)] });
    expect((await router.chooseReviewer(task('tarea'), 'claude-1')).agentId).toBe('codex');
    expect((await router.chooseReviewer(task('tarea'), 'codex')).agentId).toBe('claude-1');
    // agy sin cupo y codex ocupado: el otro Claude
    expect((await router.chooseReviewer(task('tarea'), 'claude-1')).agentId).toBe('claude-2');
  });

  it('excluye a todos los autores (p. ej. Codex que traspasó a Claude)', async () => {
    const router = new Router({ agents: [agents.claude1, agents.codex, agents.agy], quotas: [new FakeQuota('codex', 0.9), new FakeQuota('agy', 0.9)] });
    expect((await router.chooseReviewer(task('tarea'), ['codex', 'claude-1'])).agentId).toBe('agy');
    const busy = new Router({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.9)] });
    busy.acquire('codex'); // Codex ocupado con otra tarea: revisa igualmente, con aviso
    const decision = await busy.chooseReviewer(task('tarea'), 'claude-1');
    expect(decision.agentId).toBe('codex');
    expect(decision.warnings.join(' ')).toMatch(/revisa aunque ya tiene 1 tarea/);
    const exhausted = new Router({ agents: [agents.claude1, agents.codex], quotas: [new FakeQuota('codex', 0.05)] });
    await expect(exhausted.chooseReviewer(task('tarea'), 'claude-1')).rejects.toThrow(/No hay revisor disponible/);
    const onlyTwo = new Router({ agents: [agents.claude1, agents.codex] });
    await expect(onlyTwo.chooseReviewer(task('tarea'), ['codex', 'claude-1'])).rejects.toThrow(/No hay revisor disponible/);
  });
});
