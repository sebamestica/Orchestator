import { describe, expect, it, vi } from 'vitest';
import { createQuotaProviderFactory } from '../../../src/core/app/quotas.ts';
import { AgentRegistry, QuotaRefresher, lazySecrets } from '../../../src/core/registry/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { QuotaSnapshot } from '../../../src/shared/index.ts';
import { fakeKey } from '../server/helpers.ts';

/**
 * En Windows cada `vault.get` es un PowerShell (DPAPI). La lectura de cupos corre cada 5 min y solo el lector de
 * OpenRouter usa la clave: los demás no deben tocar la bóveda.
 */
describe('lectura de cupos: la clave se descifra solo si el lector la usa', () => {
  async function setup() {
    const store = new SqliteStore({ path: ':memory:' });
    const vault = new MemoryVault();
    const registry = new AgentRegistry({ store, vault });
    const keys = { claude: fakeKey(), openai: fakeKey('sk-proj-'), openrouter: fakeKey('sk-or-v1-') };
    await vault.set('claude-key', keys.claude);
    await vault.set('openai-key', keys.openai);
    await vault.set('openrouter-key', keys.openrouter);
    const base = { quotaFloor: 0.2, enabled: true } as const;
    // Los agentes con clave se dan de alta con su probe; aquí se guardan con el método que ese probe dejaría.
    store.putAgent({ config: { ...base, id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Claude', secretRef: 'claude-key', budgetUsd: 5 }, quotaMethod: 'manual-budget' });
    store.putAgent({ config: { ...base, id: 'openai', kind: 'api', provider: 'openai', displayName: 'OpenAI', secretRef: 'openai-key' }, quotaMethod: 'response-headers' });
    store.putAgent({ config: { ...base, id: 'router', kind: 'api', provider: 'openrouter', displayName: 'OpenRouter', secretRef: 'openrouter-key' }, quotaMethod: 'openrouter-key' });
    registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex', enabled: false });
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 4, usage: 6 } }))));
    const factory = createQuotaProviderFactory({ spentUsd: () => () => 1, fetch });
    const published: QuotaSnapshot[] = [];
    const refresher = new QuotaRefresher({ registry, factory, publish: (s) => { published.push(s); return s; } });
    const get = vi.spyOn(vault, 'get');
    return { vault, keys, fetch, refresher, published, get };
  }

  it('solo OpenRouter va a la bóveda y su clave llega en Authorization', async () => {
    const { keys, fetch, refresher, published, get } = await setup();
    const res = await refresher.refresh();
    expect(res.errors).toEqual([]);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('openrouter-key');
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${keys.openrouter}`);
    expect(published.map((s) => s.agentId).sort()).toEqual(['claude', 'router']);
    expect(JSON.stringify(published)).not.toContain(keys.openrouter);
  });

  it('el presupuesto manual se publica aunque su clave falte en la bóveda', async () => {
    const { vault, refresher, published } = await setup();
    await vault.delete('claude-key');
    const res = await refresher.refresh();
    expect(res.errors).toEqual([]);
    expect(published.find((s) => s.agentId === 'claude')?.buckets[0]?.remainingUnits).toEqual({ amount: 4, unit: 'usd' });
  });
});

describe('lazySecrets', () => {
  it('va a la bóveda una sola vez y reintenta si la lectura falló', async () => {
    const load = vi.fn<() => Promise<{ apiKey?: string }>>().mockRejectedValueOnce(new Error('bóveda ocupada')).mockResolvedValue({ apiKey: 'k' });
    const get = lazySecrets(load);
    await expect(get()).rejects.toThrow('ocupada');
    await expect(get()).resolves.toEqual({ apiKey: 'k' });
    await expect(get()).resolves.toEqual({ apiKey: 'k' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
