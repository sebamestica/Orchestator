import { describe, expect, it } from 'vitest';
import { AgentEnvironment } from '../../src/core/app/env.ts';
import { SqliteStore } from '../../src/core/store/index.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import { agentConfigSchema } from '../../src/shared/index.ts';
import { USER_BASE_URL, fakeKey } from './helpers.ts';

/** Bóveda falsa cuya lectura espera a que la prueba la suelte (para intercalar cambios). */
class GatedVault extends MemoryVault {
  #release: (() => void) | undefined;
  #gate: Promise<void> = Promise.resolve();
  hold(): void {
    this.#gate = new Promise((r) => {
      this.#release = r;
    });
  }
  release(): void {
    this.#release?.();
  }
  override async get(ref: string): Promise<string | undefined> {
    await this.#gate;
    return super.get(ref);
  }
}

async function setup() {
  const store = new SqliteStore({ path: ':memory:' });
  const vault = new GatedVault();
  const key = fakeKey();
  await vault.set('claude-a-key', key);
  const claude = agentConfigSchema.parse({ id: 'agente-a', kind: 'claude-sdk', provider: 'anthropic', displayName: 'A', baseUrl: USER_BASE_URL, secretRef: 'claude-a-key' });
  store.putAgent({ config: claude });
  const asCodex = () => {
    store.deleteAgent('agente-a');
    store.putAgent({ config: agentConfigSchema.parse({ id: 'agente-a', kind: 'codex-cli', provider: 'codex', displayName: 'A ahora Codex' }) });
  };
  return { store, vault, key, claude, asCodex, env: new AgentEnvironment({ agents: store, vault }) };
}

describe('AgentEnvironment (hallazgo 3 de la revisión de Codex)', () => {
  it('un load pendiente no guarda la clave si entretanto se llamó a forget y el agente pasó a ser otro', async () => {
    const { store, vault, key, asCodex, env } = await setup();
    vault.hold();
    const pending = env.load('agente-a');
    env.forget('agente-a');
    asCodex();
    vault.release();
    await expect(pending).rejects.toThrow(/cambió mientras se cargaba/);
    expect(env.envFor('agente-a')).toEqual({});
    expect(JSON.stringify(env.envFor('agente-a'))).not.toContain(key);
    store.close();
  });

  it('forget() de todos también invalida las cargas en curso', async () => {
    const { store, vault, env } = await setup();
    vault.hold();
    const pending = env.load('agente-a');
    env.forget();
    vault.release();
    await expect(pending).rejects.toThrow(/cambió mientras se cargaba/);
    expect(() => env.envFor('agente-a')).toThrow(/no está cargada/);
    store.close();
  });

  it('envFor no entrega la clave cacheada si el agente vigente cambió de tipo, de clave o de URL', async () => {
    const { store, key, claude, asCodex, env } = await setup();
    expect(await env.load('agente-a')).toEqual({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: USER_BASE_URL });
    expect(env.envFor('agente-a').ANTHROPIC_API_KEY).toBe(key);

    store.putAgent({ config: { ...claude, baseUrl: 'https://api.anthropic.com' } });
    expect(() => env.envFor('agente-a')).toThrow(/no está cargada o el agente cambió/);
    await env.load('agente-a');
    expect(env.envFor('agente-a').ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');

    asCodex();
    expect(env.envFor('agente-a')).toEqual({});
    expect(env.loaded()).toEqual([]);
    store.close();
  });
});
