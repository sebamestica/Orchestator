import { describe, expect, it } from 'vitest';
import { AgyCliAdapter } from '../../src/core/adapters/agy-cli/index.ts';
import { AgyQuotaProvider } from '../../src/core/quota/agy.ts';
import { agentConfigSchema } from '../../src/shared/index.ts';

describe.skipIf(process.env.ORQ_LIVE !== '1')('agy real (sin inferencia)', () => {
  it('detecta instalación y sesión de agy en Windows', async () => {
    const config = agentConfigSchema.parse({
      id: 'agy-live',
      kind: 'agy-cli',
      provider: 'antigravity',
      displayName: 'Antigravity CLI Live',
    });
    const probe = await new AgyCliAdapter(config).probe();
    expect(probe.installed).toBe(true);
    expect(probe.authenticated).toBe(true);
    expect(probe.models.length).toBeGreaterThan(0);
    expect(probe.quotaMethod).toBe('agy-usage');
  });

  it('consulta el cupo real mediante /usage sin gastar tokens', async () => {
    const provider = new AgyQuotaProvider('agy-live');
    const quota = await provider.read();
    expect(quota.stale).toBe(false);
    expect(quota.method).toBe('agy-usage');
    expect(quota.buckets.length).toBeGreaterThan(0);
  });
});
