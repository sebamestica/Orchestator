import { describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  QuotaRefresher,
  agyDetector,
  codexDetector,
  parseVersion,
  slugify,
  RegistryError,
  type CliDetector,
  type DetectedCli,
} from '../../../src/core/registry/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { QuotaSnapshot } from '../../../src/shared/index.ts';
import { fakeAdapterFactory, fakeKey, fakeQuotaFactory, type FakeAdapterLog } from '../server/helpers.ts';

function setup(opts: { detectors?: CliDetector[]; withFactory?: boolean } = {}) {
  const validKey = fakeKey();
  const store = new SqliteStore({ path: ':memory:' });
  const vault = new MemoryVault();
  const log: FakeAdapterLog = { probes: [] };
  const registry = new AgentRegistry({
    store,
    vault,
    ...(opts.withFactory === false ? {} : { adapterFactory: fakeAdapterFactory(validKey, log) }),
    detectors: opts.detectors ?? [],
  });
  return { validKey, store, vault, log, registry };
}

async function rejection(p: Promise<unknown>): Promise<RegistryError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RegistryError);
    return err as RegistryError;
  }
  throw new Error('se esperaba un rechazo');
}

describe('AgentRegistry.addAgentFromKey', () => {
  it('guarda la clave solo en la bóveda, prueba con la fábrica inyectada y guarda el método de cupo', async () => {
    const { registry, validKey, vault, store, log } = setup();
    const { agent, probe } = await registry.addAgentFromKey({ provider: 'anthropic', apiKey: validKey, displayName: 'Claude Ñandú', budgetUsd: 15 });
    expect(agent.config).toMatchObject({ id: 'claude-nandu', kind: 'claude-sdk', provider: 'anthropic', budgetUsd: 15 });
    expect(agent.config.secretRef).toMatch(/^claude-nandu-key-[0-9a-f]{6}$/);
    expect(agent.quotaMethod).toBe('manual-budget');
    expect(probe.authenticated).toBe(true);
    // La fábrica recibió la clave en memoria…
    expect(log.probes[0]?.apiKey).toBe(validKey);
    // …y la clave está en la bóveda, no en SQLite ni en el resultado (el probe intentó filtrarla en warnings).
    expect(await vault.get(agent.config.secretRef ?? '')).toBe(validKey);
    expect(JSON.stringify({ agent, probe, stored: store.listAgents() })).not.toContain(validKey);
    expect(probe.warnings[0]).toContain('[REDACTADO]');
    expect((await vault.list()).map((r) => r.ref)).toEqual([agent.config.secretRef]);
  });

  it('genera ids únicos y usa kind api para otros proveedores', async () => {
    const { registry, validKey } = setup();
    const a = await registry.addAgentFromKey({ provider: 'openrouter', apiKey: validKey, displayName: 'Router' });
    const b = await registry.addAgentFromKey({ provider: 'openrouter', apiKey: validKey, displayName: 'Router' });
    const c = await registry.addAgentFromKey({ provider: 'anthropic', apiKey: validKey, displayName: '¡!', kind: 'api' });
    expect([a.agent.config.id, b.agent.config.id, c.agent.config.id]).toEqual(['router', 'router-2', 'anthropic']);
    expect(a.agent.config.kind).toBe('api');
    expect(c.agent.config.kind).toBe('api');
  });

  it('deshace todo si la clave no autentica o el probe lanza, sin filtrar la clave en el error', async () => {
    const { registry, validKey, vault, store } = setup();
    const wrong = fakeKey();
    const e1 = await rejection(registry.addAgentFromKey({ provider: 'anthropic', apiKey: wrong, displayName: 'Mala' }));
    expect(e1.code).toBe('probe_failed');
    expect(JSON.stringify(e1.details)).not.toContain(wrong);
    const boom = 'sk-ant-explota-' + validKey.slice(-12);
    const e2 = await rejection(registry.addAgentFromKey({ provider: 'anthropic', apiKey: boom, displayName: 'Explota' }));
    expect(e2.code).toBe('probe_failed');
    expect(e2.message).not.toContain(boom);
    expect(store.listAgents()).toEqual([]);
    expect(await vault.list()).toEqual([]);
  });

  it('valida la entrada con Zod sin repetir la clave en el mensaje', async () => {
    const { registry } = setup();
    const key = fakeKey();
    const cases: unknown[] = [
      { provider: 'codex', apiKey: key, displayName: 'x' },
      { provider: 'openai-compatible', apiKey: key, displayName: 'x' },
      { provider: 'openai', apiKey: key, displayName: 'x', kind: 'claude-sdk' },
      { provider: 'openai', apiKey: 'corta', displayName: 'x' },
      { provider: 'openai', apiKey: key, displayName: 'x', baseUrl: 'javascript:alert(1)' },
      { provider: 'openai', apiKey: key, displayName: 'x', extra: true },
    ];
    for (const input of cases) {
      const err = await rejection(registry.addAgentFromKey(input));
      expect(err.code).toBe('invalid');
      expect(err.message).not.toContain(key);
    }
  });

  it('responde not_configured sin fábrica de adaptadores', async () => {
    const { registry } = setup({ withFactory: false });
    const err = await rejection(registry.addAgentFromKey({ provider: 'openai', apiKey: fakeKey('sk-'), displayName: 'x' }));
    expect(err.code).toBe('not_configured');
  });

  it('rechaza un id repetido', async () => {
    const { registry, validKey } = setup();
    await registry.addAgentFromKey({ provider: 'google', apiKey: validKey, displayName: 'Gemini', id: 'gemini' });
    expect((await rejection(registry.addAgentFromKey({ provider: 'google', apiKey: validKey, displayName: 'Gemini', id: 'gemini' }))).code).toBe('conflict');
  });
});

describe('AgentRegistry CRUD, probe y borrado', () => {
  it('put, update (con null borra), probe y delete con su clave', async () => {
    const { registry, validKey, vault } = setup();
    const cli = registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex CLI' });
    expect(cli.config.quotaFloor).toBe(0.2);
    expect(() => registry.put({ id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'C' })).toThrow(RegistryError);

    const { agent } = await registry.addAgentFromKey({ provider: 'openai', apiKey: validKey, displayName: 'GPT', model: 'gpt-x', budgetUsd: 3 });
    const updated = registry.update(agent.config.id, { model: null, budgetUsd: null, enabled: false, quotaFloor: 0.3 });
    expect(updated.config.model).toBeUndefined();
    expect(updated.config.budgetUsd).toBeUndefined();
    expect(updated.config).toMatchObject({ enabled: false, quotaFloor: 0.3, secretRef: agent.config.secretRef });
    expect(() => registry.update(agent.config.id, {})).toThrow(RegistryError);
    expect(() => registry.update('no-existe', { enabled: true })).toThrow(/No existe/);

    const probed = await registry.probe('codex');
    expect(probed.agent.quotaMethod).toBe('codex-ratelimits');
    expect(probed.agent.lastProbe?.models).toEqual(['modelo-a', 'modelo-b']);
    expect(await registry.secretsFor(updated.config)).toEqual({ apiKey: validKey });

    expect(await registry.delete(agent.config.id)).toBe(true);
    expect(await vault.list()).toEqual([]);
    expect(await registry.delete(agent.config.id)).toBe(false);
    expect(registry.list().map((a) => a.config.id)).toEqual(['codex']);
  });

  it('informa si falta la clave en la bóveda', async () => {
    const { registry, validKey, vault } = setup();
    const { agent } = await registry.addAgentFromKey({ provider: 'openai', apiKey: validKey, displayName: 'GPT' });
    await vault.delete(agent.config.secretRef ?? '');
    expect((await rejection(registry.probe(agent.config.id))).code).toBe('not_found');
  });

  it('aplica un tiempo máximo al probe', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const registry = new AgentRegistry({
      store,
      vault: new MemoryVault(),
      probeTimeoutMs: 50,
      adapterFactory: (config) => ({ config, probe: () => new Promise(() => undefined), run: async function* () {} }),
    });
    registry.put({ id: 'lento', kind: 'agy-cli', provider: 'antigravity', displayName: 'Lento' });
    const err = await rejection(registry.probe('lento'));
    expect(err.code).toBe('probe_failed');
    expect(err.message).toMatch(/50 ms/);
  });

  it('rechaza un probe que no cumple el contrato', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const registry = new AgentRegistry({
      store,
      vault: new MemoryVault(),
      adapterFactory: (config) => ({ config, probe: async () => ({ agentId: config.id }) as never, run: async function* () {} }),
    });
    registry.put({ id: 'raro', kind: 'agy-cli', provider: 'antigravity', displayName: 'Raro' });
    expect((await rejection(registry.probe('raro'))).message).toMatch(/probe inválido/);
  });
});

describe('detectores de CLIs', () => {
  const env = { APPDATA: 'C:\\Users\\yo\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\yo\\AppData\\Local' };

  it('detecta codex (node + codex.js) y agy (agy.exe) con funciones inyectadas, sin shell', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const deps = {
      platform: 'win32' as const,
      env,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      exists: async (p: string) => p.endsWith('codex.js') || p.endsWith('agy.exe'),
      runVersion: async (command: string, args: readonly string[]) => {
        calls.push({ command, args });
        return { exitCode: 0, output: command.endsWith('agy.exe') ? '1.4.12' : 'codex-cli 0.165.0' };
      },
    };
    const codex = await codexDetector(deps).detect();
    const agy = await agyDetector(deps).detect();
    expect(codex).toEqual({
      id: 'codex',
      kind: 'codex-cli',
      provider: 'codex',
      displayName: 'Codex CLI',
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argsPrefix: ['C:\\Users\\yo\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
      version: '0.165.0',
    });
    expect(agy).toMatchObject({ id: 'agy', kind: 'agy-cli', provider: 'antigravity', executable: 'C:\\Users\\yo\\AppData\\Local\\agy\\bin\\agy.exe', version: '1.4.12' });
    expect(calls.map((c) => c.command)).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\yo\\AppData\\Local\\agy\\bin\\agy.exe']);
  });

  it('devuelve null si no está instalado, si falla --version o fuera de Windows', async () => {
    const base = { platform: 'win32' as const, env, runVersion: async () => ({ exitCode: 0, output: '1.0.0' }) };
    expect(await codexDetector({ ...base, exists: async () => false }).detect()).toBeNull();
    expect(await agyDetector({ ...base, exists: async () => true, runVersion: async () => ({ exitCode: 1, output: '' }) }).detect()).toBeNull();
    expect(await agyDetector({ ...base, exists: async () => true, runVersion: async () => { throw new Error('ENOENT'); } }).detect()).toBeNull();
    expect(await codexDetector({ ...base, platform: 'linux', exists: async () => true }).detect()).toBeNull();
  });

  it('parseVersion y slugify', () => {
    expect(parseVersion('codex-cli 0.165.0\n')).toBe('0.165.0');
    expect(parseVersion('v1.4.12-beta.1')).toBe('1.4.12-beta.1');
    expect(parseVersion('sin versión')).toBeUndefined();
    expect(slugify('  Claude Ópus (mi clave) ')).toBe('claude-opus-mi-clave');
  });

  it('detectClis registra solo los nuevos y tolera detectores que fallan', async () => {
    const found: DetectedCli = { id: 'agy', kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity (agy)', executable: 'agy.exe', argsPrefix: [] };
    const detectors: CliDetector[] = [
      { name: 'agy', detect: async () => found },
      { name: 'roto', detect: async () => { throw new Error('x'); } },
      { name: 'nada', detect: async () => null },
    ];
    const { registry } = setup({ detectors });
    const first = await registry.detectClis();
    expect(first.detected).toEqual([found]);
    expect(first.added.map((a) => a.config)).toEqual([{ id: 'agy', kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity (agy)', quotaFloor: 0.2, enabled: true }]);
    const second = await registry.detectClis();
    expect(second.added).toEqual([]);
  });
});

describe('QuotaRefresher', () => {
  it('lee los agentes habilitados, publica cada foto y tacha los errores', async () => {
    const { registry, validKey } = setup();
    registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
    registry.put({ id: 'apagado', kind: 'agy-cli', provider: 'antigravity', displayName: 'Off', enabled: false });
    await registry.addAgentFromKey({ provider: 'openai', apiKey: validKey, displayName: 'Roto', id: 'roto-1' });
    const published: QuotaSnapshot[] = [];
    const refresher = new QuotaRefresher({ registry, factory: fakeQuotaFactory(), publish: (s) => { published.push(s); return s; } });
    const res = await refresher.refresh();
    expect(res.quotas.map((q) => q.agentId)).toEqual(['codex']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.agentId).toBe('roto-1');
    expect(res.errors[0]?.message).not.toContain(validKey);
    expect(published).toHaveLength(1);
    const one = await refresher.refresh('apagado');
    expect(one.quotas.map((q) => q.agentId)).toEqual(['apagado']);
    expect(() => refresher.refresh('no-existe')).toThrow(RegistryError);
  });

  it('descarta fotos que no cumplen el contrato y respeta el tiempo máximo', async () => {
    const { registry } = setup();
    registry.put({ id: 'raro', kind: 'agy-cli', provider: 'antigravity', displayName: 'Raro' });
    registry.put({ id: 'lento', kind: 'agy-cli', provider: 'antigravity', displayName: 'Lento' });
    const refresher = new QuotaRefresher({
      registry,
      timeoutMs: 50,
      factory: (agent) => ({
        agentId: agent.config.id,
        read: () => (agent.config.id === 'raro' ? Promise.resolve({ nada: true } as never) : new Promise<never>(() => undefined)),
      }),
      publish: (s) => s,
    });
    const res = await refresher.refresh();
    expect(res.quotas).toEqual([]);
    expect(res.errors.map((e) => e.message).sort()).toEqual(['foto de cupo inválida', 'sin respuesta en 50 ms']);
  });
});
