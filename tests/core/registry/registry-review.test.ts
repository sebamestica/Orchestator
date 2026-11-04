import { describe, expect, it } from 'vitest';
import { AgentRegistry, QuotaRefresher, RegistryError, type AgentStore } from '../../../src/core/registry/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { QuotaSnapshot } from '../../../src/shared/index.ts';
import { fakeAdapterFactory, fakeKey } from '../server/helpers.ts';

/** Clave opaca: no coincide con ningún patrón de `redactSecrets`, solo se tacha por valor conocido. */
const opaqueKey = () => fakeKey('opaca-');

// Revisión de seguridad 2026-11-01 (Codex), hallazgos 1 y 4.
describe('revisión: cupo con clave opaca (hallazgo 1)', () => {
  it('la foto de cupo se tacha con la clave del agente antes de publicarse', async () => {
    const key = opaqueKey();
    const store = new SqliteStore({ path: ':memory:' });
    const registry = new AgentRegistry({ store, vault: new MemoryVault(), adapterFactory: fakeAdapterFactory(key) });
    await registry.addAgentFromKey({ provider: 'openai-compatible', apiKey: key, displayName: 'Compatible', baseUrl: 'https://llm.example.com/v1', id: 'compat' });
    const published: QuotaSnapshot[] = [];
    const refresher = new QuotaRefresher({
      registry,
      factory: (agent, secrets) => ({
        agentId: agent.config.id,
        read: async () => ({
          agentId: agent.config.id,
          method: 'response-headers',
          takenAt: '2026-11-01T20:00:00.000Z',
          buckets: [{ groupId: 'g', groupName: `grupo ${secrets.apiKey ?? ''}`, window: 'daily', remainingFraction: 0.5 }],
          stale: false,
          error: `el proveedor repitió la clave ${secrets.apiKey ?? ''}`,
        }),
      }),
      publish: (s) => {
        published.push(s);
        return store.recordQuota(s);
      },
    });
    const res = await refresher.refresh();
    expect(res.quotas).toHaveLength(1);
    expect(JSON.stringify(published)).not.toContain(key);
    expect(JSON.stringify(res)).not.toContain(key);
    expect(JSON.stringify(store.latestQuotas())).not.toContain(key);
    expect(published[0]?.error).toContain('[REDACTADO]');
  });
});

describe('revisión: altas concurrentes y reversión de la clave (hallazgo 4)', () => {
  function setup(storeOverride?: (s: SqliteStore) => AgentStore) {
    const key = fakeKey();
    const sqlite = new SqliteStore({ path: ':memory:' });
    const vault = new MemoryVault();
    const registry = new AgentRegistry({ store: storeOverride ? storeOverride(sqlite) : sqlite, vault, adapterFactory: fakeAdapterFactory(key) });
    return { key, sqlite, vault, registry };
  }

  it('dos altas simultáneas con el mismo id: una gana, la otra da conflicto y no quedan claves huérfanas', async () => {
    const { key, vault, registry } = setup();
    const results = await Promise.allSettled([
      registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, displayName: 'Claude A', id: 'claude' }),
      registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, displayName: 'Claude B', id: 'claude' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(RegistryError);
    expect(((failed[0] as PromiseRejectedResult).reason as RegistryError).code).toBe('conflict');
    const refs = (await vault.list()).map((r) => r.ref);
    expect(refs).toHaveLength(1);
    expect(registry.list().map((a) => a.config.secretRef)).toEqual(refs);
  });

  it('dos altas simultáneas sin id con el mismo nombre reciben ids distintos', async () => {
    const { key, vault, registry } = setup();
    const [a, b] = await Promise.all([
      registry.addAgentFromKey({ provider: 'openai', apiKey: key, displayName: 'GPT' }),
      registry.addAgentFromKey({ provider: 'openai', apiKey: key, displayName: 'GPT' }),
    ]);
    expect([a.agent.config.id, b.agent.config.id].sort()).toEqual(['gpt', 'gpt-2']);
    expect(await vault.list()).toHaveLength(2);
    expect(registry.list()).toHaveLength(2);
  });

  it('el alta no reemplaza un agente creado mientras se probaba (inserción exclusiva)', async () => {
    const { key, vault, registry, sqlite } = setup();
    const pending = registry.addAgentFromKey({ provider: 'openai', apiKey: key, displayName: 'GPT', id: 'gpt' });
    // Otro camino (p. ej. otra instancia sobre la misma base) crea el mismo id durante el probe.
    sqlite.putAgent({ config: { id: 'gpt', kind: 'codex-cli', provider: 'codex', displayName: 'Ya estaba', quotaFloor: 0.2, enabled: true } });
    await expect(pending).rejects.toMatchObject({ code: 'conflict' });
    expect(sqlite.getAgent('gpt')?.config.displayName).toBe('Ya estaba');
    expect(await vault.list()).toEqual([]);
  });

  it('si falla el guardado después del probe, la clave se borra de la bóveda', async () => {
    const { key, vault, registry } = setup((s) => ({
      getAgent: (id) => s.getAgent(id),
      listAgents: () => s.listAgents(),
      deleteAgent: (id) => s.deleteAgent(id),
      putAgent: (i) => s.putAgent(i),
      createAgent: () => {
        throw new Error('disco lleno');
      },
    }));
    await expect(registry.addAgentFromKey({ provider: 'openai', apiKey: key, displayName: 'GPT' })).rejects.toThrow();
    expect(await vault.list()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});

// Hallazgo posterior (Codex, revisión de src/core/app): la clave se guardaba antes del probe.
describe('revisión: la clave solo se guarda si el probe sale bien', () => {
  it('durante el probe la bóveda sigue vacía: si el proceso muere ahí no queda una clave sin probar', async () => {
    const key = fakeKey();
    const store = new SqliteStore({ path: ':memory:' });
    const vault = new MemoryVault();
    const seenDuringProbe: string[][] = [];
    const inner = fakeAdapterFactory(key);
    const registry = new AgentRegistry({
      store,
      vault,
      adapterFactory: async (config, secrets) => {
        const adapter = await inner(config, secrets);
        return {
          ...adapter,
          probe: async () => {
            seenDuringProbe.push((await vault.list()).map((r) => r.ref));
            return adapter.probe();
          },
        };
      },
    });
    const { agent } = await registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, displayName: 'Claude' });
    expect(seenDuringProbe).toEqual([[]]);
    expect((await vault.list()).map((r) => r.ref)).toEqual([agent.config.secretRef]);
    expect(await vault.get(agent.config.secretRef ?? '')).toBe(key);
  });

  it('un probe fallido no toca la bóveda (aunque borrar fallara, no queda nada)', async () => {
    const key = fakeKey();
    const vault = new MemoryVault();
    const calls: string[] = [];
    const spy = {
      set: (ref: string, value: string, meta?: { label?: string }) => (calls.push('set'), vault.set(ref, value, meta)),
      get: (ref: string) => vault.get(ref),
      delete: async (ref: string): Promise<boolean> => {
        calls.push('delete');
        throw new Error(`no se pudo borrar ${ref}`);
      },
      list: () => vault.list(),
    };
    const registry = new AgentRegistry({ store: new SqliteStore({ path: ':memory:' }), vault: spy, adapterFactory: fakeAdapterFactory(key) });
    await expect(registry.addAgentFromKey({ provider: 'openai', apiKey: fakeKey(), displayName: 'Mala' })).rejects.toMatchObject({ code: 'probe_failed' });
    expect(calls).toEqual([]);
    expect(await vault.list()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('si vault.set falla después de guardar el agente, el agente se revierte', async () => {
    const key = fakeKey();
    const vault = new MemoryVault();
    const failing = { ...vault, set: async () => { throw new Error('DPAPI no disponible'); }, list: () => vault.list(), get: (r: string) => vault.get(r), delete: (r: string) => vault.delete(r) };
    const store = new SqliteStore({ path: ':memory:' });
    const registry = new AgentRegistry({ store, vault: failing, adapterFactory: fakeAdapterFactory(key) });
    await expect(registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, displayName: 'Claude', id: 'claude' })).rejects.toThrow(/DPAPI/);
    expect(store.listAgents()).toEqual([]);
    expect(await vault.list()).toEqual([]);
    // El id queda libre para reintentar.
    const ok = new AgentRegistry({ store, vault, adapterFactory: fakeAdapterFactory(key) });
    expect((await ok.addAgentFromKey({ provider: 'anthropic', apiKey: key, displayName: 'Claude', id: 'claude' })).agent.config.id).toBe('claude');
  });
});
