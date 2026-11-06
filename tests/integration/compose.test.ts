import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiChatAdapter } from '../../src/core/adapters/api/index.ts';
import { ClaudeSdkAdapter, type ClaudeSdkAdapterOptions } from '../../src/core/adapters/claude-sdk/index.ts';
import { compose, type ComposeOptions, type Composition } from '../../src/core/app/compose.ts';
import { Router, Supervisor } from '../../src/core/orchestrator/index.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import { agentConfigSchema, type AgentConfig } from '../../src/shared/index.ts';
import { USER_BASE_URL, anthropicRoutes, cleanupDirs, fakeKey, leakyAdapter, messageResponse, mockFetch, okTask, planJson, tempDir } from './helpers.ts';

const comps: Composition[] = [];
afterEach(async () => {
  for (const c of comps.splice(0)) c.close();
  await cleanupDirs();
});

/** Bóveda falsa (en memoria) que registra qué referencias se leen. */
class RecordingVault extends MemoryVault {
  readonly reads: string[] = [];
  override async get(ref: string): Promise<string | undefined> {
    this.reads.push(ref);
    return super.get(ref);
  }
}

const HOST_KEY = fakeKey('anfitrion');

async function setup(extra: Partial<ComposeOptions> = {}) {
  const dir = await tempDir();
  const log: string[] = [];
  const net = mockFetch(anthropicRoutes(planJson('orquestador')));
  const vault = new RecordingVault();
  const comp = compose({
    env: { ORQ_DATA_DIR: dir },
    config: { port: 0 },
    vault,
    memoryDir: `${dir}/memoria`,
    skillsHubDir: `${dir}/hub`,
    projectDir: dir,
    detectors: [],
    anthropicFetch: net.fetch,
    // El entorno anfitrión trae otra clave y otra URL: nunca deben usarse.
    hostEnv: () => ({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: HOST_KEY, ANTHROPIC_AUTH_TOKEN: HOST_KEY, ANTHROPIC_BASE_URL: 'https://anfitrion.invalid' }),
    claude: { sdkVersion: '0.3.302' },
    log: (l) => log.push(l),
    ...extra,
  });
  comps.push(comp);
  return { dir, log, net, vault, comp };
}

const cfg = (v: Record<string, unknown>): AgentConfig => agentConfigSchema.parse({ displayName: String(v.id), ...v });

describe('compose: fábrica de adaptadores', () => {
  it('elige el adaptador según kind y entrega a Claude solo la clave de la bóveda y la URL del agente', async () => {
    const made: string[] = [];
    let claudeOpts: ClaudeSdkAdapterOptions | undefined;
    const { comp } = await setup({
      constructors: {
        claudeSdk: (o) => {
          made.push(`claude-sdk:${o.config.id}`);
          claudeOpts = o;
          return leakyAdapter(o.config, []);
        },
        codexCli: (c) => (made.push(`codex-cli:${c.id}`), leakyAdapter(c, [])),
        agyCli: (c) => (made.push(`agy-cli:${c.id}`), leakyAdapter(c, [])),
      },
    });
    const key = fakeKey();
    await comp.adapterFactory(cfg({ id: 'claude', kind: 'claude-sdk', provider: 'anthropic', baseUrl: USER_BASE_URL, secretRef: 'claude-key' }), { apiKey: key });
    await comp.adapterFactory(cfg({ id: 'codex', kind: 'codex-cli', provider: 'codex' }), {});
    await comp.adapterFactory(cfg({ id: 'agy', kind: 'agy-cli', provider: 'antigravity' }), {});
    expect(made).toEqual(['claude-sdk:claude', 'codex-cli:codex', 'agy-cli:agy']);

    expect(await claudeOpts?.probeEnv?.()).toEqual({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: USER_BASE_URL });
    expect(claudeOpts?.baseEnv).toEqual({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: USER_BASE_URL });
    expect(JSON.stringify(claudeOpts?.baseEnv)).not.toContain(HOST_KEY);
    expect(await claudeOpts?.spentUsd?.()).toBe(0);

    const api = cfg({ id: 'gpt', kind: 'api', provider: 'openai', secretRef: 'gpt-key' });
    // Por defecto, el ApiChatAdapter de c6 (antes era un hueco).
    expect(await comp.adapterFactory(api, { apiKey: fakeKey() })).toBeInstanceOf(ApiChatAdapter);
  });

  it('el presupuesto de la clave es común: el adaptador y el cupo manual descuentan lo que gasta la mente', async () => {
    const seen = new Map<string, ClaudeSdkAdapterOptions>();
    const { comp } = await setup({ constructors: { claudeSdk: (o) => (seen.set(o.config.id, o), leakyAdapter(o.config, [])) } });
    const claude = comp.store.putAgent({ config: cfg({ id: 'claude', kind: 'claude-sdk', provider: 'anthropic', secretRef: 'claude-key', budgetUsd: 20 }) });
    const other = comp.store.putAgent({ config: cfg({ id: 'claude-b', kind: 'claude-sdk', provider: 'anthropic', secretRef: 'b-key', budgetUsd: 20 }) });
    const usage = (agentId: string, costUsd: number, seq: number) =>
      comp.store.appendEvent({ sessionId: `s-${agentId}`, agentId, seq, ts: '2026-11-05T18:00:00.000Z', type: 'usage', payload: { inputTokens: 1, outputTokens: 1, costUsd } });
    usage('claude', 10, 0);
    usage('orquestador', 5, 0);
    await comp.adapterFactory(claude.config, { apiKey: fakeKey() });
    await comp.adapterFactory(other.config, { apiKey: fakeKey() });

    // `claude` es la mente (primer Claude habilitado): su clave paga también lo de `orquestador`.
    expect(await seen.get('claude')?.spentUsd?.()).toBe(15);
    expect(await seen.get('claude-b')?.spentUsd?.()).toBe(0);
    const snap = await comp.quotaProviderFactory({ ...claude, quotaMethod: 'manual-budget' }, {})?.read();
    expect(snap?.buckets[0]).toMatchObject({ remainingUnits: { amount: 5, unit: 'usd' }, remainingFraction: 0.25 });

    // Lo que lleva en curso un proceso vivo (otra tarea o un chat) también se descuenta, hasta que termina.
    const live = comp.liveSpend.open('claude');
    live.set(2);
    expect(comp.billedSpentUsd('claude')).toBe(17);
    live.close();
    expect(comp.billedSpentUsd('claude')).toBe(15);
  });

  it('el adaptador de API se puede reemplazar con `api`', async () => {
    const seen: string[] = [];
    const { comp } = await setup({ api: (c, s) => (seen.push(`${c.id}:${s.apiKey ? 'con-clave' : 'sin-clave'}`), leakyAdapter(c, [])) });
    await comp.adapterFactory(cfg({ id: 'gpt', kind: 'api', provider: 'openai', secretRef: 'gpt-key' }), { apiKey: fakeKey() });
    expect(seen).toEqual(['gpt:con-clave']);
  });

  it('sin inyectar nada crea ClaudeSdkAdapter real: el probe va a la URL del agente con la clave de la bóveda', async () => {
    const { comp, net, log } = await setup();
    const key = fakeKey();
    const res = await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude', budgetUsd: 1 });
    expect(res.probe).toMatchObject({ authenticated: true, quotaMethod: 'manual-budget' });
    expect(res.probe.warnings.some((w) => w.includes('conexión sin cifrar'))).toBe(true);
    expect(net.calls[0]?.url).toBe(`${USER_BASE_URL}/v1/models?limit=100`);
    expect(net.calls[0]?.headers.get('x-api-key')).toBe(key);
    expect(net.calls[0]?.headers.get('authorization')).toBeNull();
    expect(await comp.registry.createAdapter('claude')).toBeInstanceOf(ClaudeSdkAdapter);
    expect(JSON.stringify([res, comp.registry.list(), log])).not.toContain(key);
  });
});

describe('compose: envFor', () => {
  it('entrega a cada agente solo su clave, en memoria, y Supervisor la tacha de los eventos', async () => {
    const { comp, vault, log } = await setup();
    const keyA = fakeKey('a');
    const keyB = fakeKey('b');
    await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: keyA, baseUrl: USER_BASE_URL, displayName: 'Claude A', id: 'claude-a' });
    await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: keyB, displayName: 'Claude B', id: 'claude-b' });
    comp.registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });

    expect(() => comp.envFor('claude-a')).toThrow(/no está cargada/);
    vault.reads.length = 0;
    await comp.env.loadAll();
    expect(vault.reads).toHaveLength(2);
    expect(comp.envFor('claude-a')).toEqual({ ANTHROPIC_API_KEY: keyA, ANTHROPIC_BASE_URL: USER_BASE_URL });
    expect(comp.envFor('claude-b')).toEqual({ ANTHROPIC_API_KEY: keyB });
    expect(comp.envFor('codex')).toEqual({});

    const seen: { agentId: string; env: Readonly<Record<string, string>> }[] = [];
    const configs = comp.registry.list().map((a) => a.config);
    const supervisor = new Supervisor({
      adapters: configs.map((c) => leakyAdapter(c, seen)),
      router: new Router({ agents: configs }),
      sink: comp.store,
      env: comp.envFor,
    });
    const a = await supervisor.execute(okTask('tarea-a'), { agentId: 'claude-a', worktreePath: comp.config.dataDir, maxAttempts: 1, updateQueue: false });
    const c = await supervisor.execute(okTask('tarea-c'), { agentId: 'codex', worktreePath: comp.config.dataDir, maxAttempts: 1, updateQueue: false });
    expect(a.ok && c.ok).toBe(true);
    expect(seen.map((s) => [s.agentId, s.env.ANTHROPIC_API_KEY === keyA, s.env.ANTHROPIC_API_KEY === keyB])).toEqual([
      ['claude-a', true, false],
      ['codex', false, false],
    ]);
    const stored = JSON.stringify(comp.store.eventsSince('s-claude-a'));
    expect(stored).toContain('mi clave es [REDACTADO]');
    expect(JSON.stringify([stored, a, log])).not.toContain(keyA);
    expect(comp.spentUsd('claude-a')).toBeCloseTo(0.001, 6);
  });
});

describe('compose: planificador', () => {
  it('llama a Claude en la URL del agente con su clave y registra el consumo en su presupuesto', async () => {
    const { comp, net } = await setup();
    const key = fakeKey();
    await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude', budgetUsd: 1 });
    const result = await comp.planner.plan({ projectId: 'orquestador', text: '1. A\n2. B', knownTaskIds: [] });
    expect(result.ok && result.tasks.map((t) => t.id)).toEqual(['tarea-a', 'tarea-b']);

    const call = net.calls.find((x) => x.method === 'POST');
    expect(call?.url).toBe(`${USER_BASE_URL}/v1/messages`);
    expect(call?.headers.get('x-api-key')).toBe(key);
    const body = JSON.parse(call?.body ?? '{}') as { model?: string; output_config?: { effort?: string }; system?: string };
    // Issue 6: planificar es pasar a JSON un plan ya escrito → Sonnet 5.5 en esfuerzo low.
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'low' } });
    expect(body.system).toContain('planificador');

    // El servidor falso responde como Opus 5.5: 1200 de entrada × 4 USD/M + 300 de salida × 20 USD/M (precio del modelo que respondió).
    expect(comp.spentUsd('claude')).toBeCloseTo(0.0108, 6);
    const quota = await comp.quotaProviderFactory(comp.registry.require('claude'), { apiKey: key });
    const snap = await quota?.read();
    expect(snap?.buckets[0]?.remainingUnits).toEqual({ amount: 0.9892, unit: 'usd' });
    expect(JSON.stringify([snap, comp.store.listSessions({})])).not.toContain(key);
  });

  it('tacha su propia clave (aunque no tenga prefijo conocido) en sistema, plan y reparaciones', async () => {
    // Hallazgo 2 de la revisión de Codex: una clave de servidor propio pegada en el plan viajaba en el cuerpo HTTP.
    const key = `claveprop-${randomBytes(16).toString('hex')}`;
    let replies = 0;
    const net = mockFetch((call) => {
      if (call.method === 'GET') return anthropicRoutes('')(call);
      replies++;
      // Primera respuesta inválida (fuerza una reparación) que repite la clave; luego un plan válido.
      return replies === 1 ? messageResponse(`no es JSON ${key}`) : messageResponse(planJson('orquestador'));
    });
    const { comp } = await setup({ anthropicFetch: net.fetch });
    await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude' });
    const result = await comp.planner.plan({ projectId: 'orquestador', text: `1. A con la clave ${key}\n2. B`, knownTaskIds: [] });
    expect(result.ok).toBe(true);
    const posts = net.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.body).not.toContain(key);
      expect(p.body).toContain('[REDACTADO]');
    }
  });

  it('sin agente Claude con clave responde 501 (not_configured)', async () => {
    const { comp } = await setup();
    await expect(comp.planner.plan({ projectId: 'orquestador', text: 'x', knownTaskIds: [] })).rejects.toMatchObject({ status: 501, code: 'not_configured' });
  });
});
