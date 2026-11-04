import { describe, expect, it } from 'vitest';
import { CodexCliAdapter } from '../../src/core/adapters/codex-cli/index.ts';
import { CodexQuotaProvider } from '../../src/core/quota/codex.ts';
import { agentConfigSchema } from '../../src/shared/index.ts';

describe.skipIf(process.env.ORQ_LIVE !== '1')('Codex real (sin inferencia)', () => {
  it('detecta instalación y sesión de Windows', async () => {
    const config = agentConfigSchema.parse({ id: 'codex-live', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
    const probe = await new CodexCliAdapter(config).probe();
    expect(probe.installed).toBe(true);
    expect(probe.authenticated).toBe(true);
  });
  it('consulta cupo por app-server o sesiones', async () => {
    const quota = await new CodexQuotaProvider('codex-live').read();
    expect(quota.buckets.length).toBeGreaterThan(0);
  });
});
