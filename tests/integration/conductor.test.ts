import { afterEach, describe, expect, it } from 'vitest';
import { conversar } from '../../src/core/app/cli-conversar.ts';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { createConductor, usageDeltas } from '../../src/core/app/conductor.ts';
import { CONDUCTOR_AGENT_ID, type ConductorQueryFn } from '../../src/core/conductor/index.ts';
import { QuotaMonitor } from '../../src/core/quota/monitor.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import type { AgentEvent } from '../../src/shared/index.ts';
import { assistantText, resultMessage, scriptedQuery } from '../core/conductor/fakes.ts';
import { USER_BASE_URL, anthropicRoutes, cleanupDirs, fakeKey, mockFetch, planJson, tempDir } from './helpers.ts';

const comps: Composition[] = [];
afterEach(async () => {
  for (const c of comps.splice(0)) c.close();
  await cleanupDirs();
});

const HOST_KEY = fakeKey('anfitrion');

async function setup() {
  const dir = await tempDir();
  const net = mockFetch(anthropicRoutes(planJson('demo')));
  const comp = compose({
    env: { ORQ_DATA_DIR: dir },
    config: { port: 0, quotaRefreshMs: 0 },
    vault: new MemoryVault(),
    memoryDir: `${dir}/memoria`,
    skillsHubDir: `${dir}/hub`,
    projectDir: dir,
    detectors: [],
    anthropicFetch: net.fetch,
    hostEnv: () => ({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: HOST_KEY, ANTHROPIC_BASE_URL: 'https://anfitrion.invalid' }),
    claude: { sdkVersion: '0.3.302' },
  });
  comps.push(comp);
  const key = fakeKey();
  await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude', budgetUsd: 2 });
  return { dir, net, comp, key };
}

describe('conductor (c11) conectado a la composición', () => {
  it('la sesión recibe la clave y la URL de la bóveda; los puertos son las piezas reales', async () => {
    const { dir, net, comp, key } = await setup();
    const q = scriptedQuery(() => [assistantText('listo'), resultMessage('listo')]);
    const conductor = await createConductor(comp, { projectId: 'demo', cwd: dir, query: q.fn, quotaTimeoutMs: 1_000 });
    try {
      expect(conductor.quotas).toBeInstanceOf(QuotaMonitor);
      expect(conductor.quotas.all().map((s) => [s.agentId, s.method])).toEqual([['claude', 'manual-budget']]);
      expect(conductor.fleet).toBe(await comp.fleet.port());

      // crear_tareas → planToTasks (c2) con la misma clave y URL; delegar sin worktrees (c3) se rechaza.
      const created = await conductor.session.tools.call('crear_tareas', { plan: '1. A\n2. B' });
      expect(created.isError).toBeFalsy();
      expect(net.calls.find((c) => c.method === 'POST')?.url).toBe(`${USER_BASE_URL}/v1/messages`);
      expect(conductor.proposals.list('demo').map((p) => [p.task.id, p.approval])).toEqual([['tarea-a', 'proposed'], ['tarea-b', 'proposed']]);
      // Modo plan (por defecto): delegar no está disponible; aprobar entrega directo a la flota real compartida.
      expect(q.calls).toHaveLength(0);
      const blocked = await conductor.session.tools.call('delegar', { taskId: 'tarea-a' });
      expect(blocked.isError).toBe(true);
      // «demo» no tiene repo registrado, así que la tarea falla antes de lanzar agentes.
      expect(await conductor.approve(['tarea-a'])).toEqual({ delivered: ['tarea-a'], failed: [] });
      expect(conductor.proposals.get('tarea-a')?.approval).toBe('delegated');
      for (let i = 0; i < 100 && comp.fleet.queue.get('tarea-a')?.state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 20));
      expect(comp.fleet.queue.get('tarea-a')?.state).toBe('failed');

      const events: AgentEvent[] = [];
      const reader = (async () => {
        for await (const e of conductor.session.events()) {
          events.push(e);
          if (e.type === 'done') break;
        }
      })();
      conductor.session.send('hola');
      await reader;
      // events() solo existe con el traductor inyectado (ClaudeSdkTranslator de c1).
      expect(events.some((e) => e.type === 'text' && e.payload.text === 'listo')).toBe(true);

      const env = q.calls[0]?.options.env ?? {};
      expect(env.ANTHROPIC_API_KEY).toBe(key);
      expect(env.ANTHROPIC_BASE_URL).toBe(USER_BASE_URL);
      expect(env.PATH).toBe('C:\\Windows');
      expect(JSON.stringify(env)).not.toContain(HOST_KEY);
      // Tope de la conversación: lo que quedaba del presupuesto del agente al abrir la sesión (2 USD, nada gastado).
      expect(q.calls[0]?.options.maxBudgetUsd).toBe(2);
      // El planificador cobra a la misma clave: 1200 × 4 + 300 × 20 por millón (Opus 5.5).
      expect(comp.spentUsd('claude')).toBeCloseTo(0.0108, 6);
      expect(JSON.stringify(events)).not.toContain(key);
    } finally {
      await conductor.close();
    }
  });
});

describe('cli conversar', () => {
  it('manda cada línea a la sesión, imprime las respuestas y guarda el uso sin contarlo dos veces', async () => {
    const { dir, comp, key } = await setup();
    let turn = 0;
    const q = scriptedQuery(() => {
      turn++;
      return [assistantText(`respuesta ${turn}`), { ...resultMessage(`respuesta ${turn}`), total_cost_usd: 0.01 * turn } as ReturnType<typeof resultMessage>];
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      out: (l: string) => void stdout.push(l),
      err: (l: string) => void stderr.push(l),
      env: {},
      stdinIsTty: true,
      readStdin: async () => '',
      lines: async function* () {
        yield* ['hola', '', 'segunda', '/propuestas', '/aprobar nada', '/salir', 'no-se-envía'];
      },
      waitForStop: async () => undefined,
    };
    const code = await conversar(['--proyecto', 'demo', '--carpeta', dir], io, comp, { query: q.fn as ConductorQueryFn, quotaTimeoutMs: 1_000 });
    expect(code).toBe(0);
    expect(q.received).toHaveLength(2);
    expect(stdout.filter((l) => l.startsWith('orquestador>'))).toEqual(['orquestador> respuesta 1', 'orquestador> respuesta 2']);
    expect(stdout).toContain('(sin tareas propuestas)');
    expect(stderr.some((l) => l.includes('No existe la tarea nada'))).toBe(true);
    // Costo acumulado del SDK: 0,01 y luego 0,02 → se guardan 0,01 + 0,01.
    expect(comp.spentUsd(CONDUCTOR_AGENT_ID)).toBeCloseTo(0.02, 9);
    expect(stdout.at(-1)).toBe('Gasto del orquestador registrado en SQLite: 0.0200 USD');
    expect(JSON.stringify([stdout, stderr])).not.toContain(key);
  });
});

describe('usageDeltas', () => {
  it('convierte el uso acumulado de cada resultado en diferencias por sesión y modelo', () => {
    const delta = usageDeltas();
    const usage = (inputTokens: number, outputTokens: number, costUsd: number, sessionId = 's1'): AgentEvent => ({
      sessionId, agentId: 'orquestador', seq: 0, ts: '2026-11-01T23:00:00.000Z', type: 'usage', payload: { inputTokens, outputTokens, costUsd, model: 'claude-opus-5-5' },
    });
    expect(delta(usage(100, 10, 0.5))?.payload).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
    expect(delta(usage(250, 30, 1.25))?.payload).toMatchObject({ inputTokens: 150, outputTokens: 20, costUsd: 0.75 });
    expect(delta(usage(250, 30, 1.25))).toBeUndefined();
    expect(delta(usage(5, 1, 0.1, 's2'))?.payload).toMatchObject({ inputTokens: 5, outputTokens: 1, costUsd: 0.1 });
  });
});
