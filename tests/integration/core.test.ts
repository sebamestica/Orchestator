import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { startCore, type Core } from '../../src/core/main.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import { USER_BASE_URL, anthropicRoutes, cleanupDirs, fakeKey, mockFetch, planJson, tempDir } from './helpers.ts';

const cores: Core[] = [];
const comps: Composition[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const c of comps.splice(0)) c.close();
  await cleanupDirs();
});

async function readIfExists(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    return Buffer.alloc(0);
  }
}

describe('startCore con compose', () => {
  it('conecta agentes, planificador, uso y skills; la clave no sale en respuestas, registros ni SQLite', async () => {
    const dir = await tempDir();
    const log: string[] = [];
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
      hostEnv: () => ({}),
      claude: { sdkVersion: '0.3.302' },
      log: (l) => log.push(l),
      validateResponses: true,
    });
    comps.push(comp);
    const core = await startCore(comp.deps);
    cores.push(core);
    expect(core.store).toBe(comp.store);
    expect(core.quotas).toBeDefined();

    const key = fakeKey();
    const bodies: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${core.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${core.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      bodies.push(text);
      return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
    };

    const added = await call('POST', '/agents', { provider: 'anthropic', apiKey: key, baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude', budgetUsd: 1 });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ agent: { config: { id: 'claude', kind: 'claude-sdk', baseUrl: USER_BASE_URL, budgetUsd: 1 } }, probe: { authenticated: true } });

    expect((await call('POST', '/projects', { id: 'demo', name: 'Demo', repoPath: dir })).status).toBe(201);
    const plan = await call('POST', '/plans', { projectId: 'demo', text: '1. A\n2. B' });
    expect(plan.status).toBe(201);
    expect((plan.json.tasks as { task: { id: string } }[]).map((t) => t.task.id)).toEqual(['tarea-a', 'tarea-b']);

    const usage = await call('GET', '/usage?groupBy=agent');
    expect((usage.json.rows as { agentId: string; costUsd: number }[])[0]).toMatchObject({ agentId: 'claude' });
    expect((usage.json.rows as { costUsd: number }[])[0]?.costUsd).toBeGreaterThan(0);

    const quotas = await call('POST', '/quotas/refresh', {});
    expect(quotas.status).toBe(200);
    expect(JSON.stringify(quotas.json)).toContain('manual-budget');

    expect((await call('GET', '/skills')).status).toBe(200);
    expect((await call('GET', '/agents')).status).toBe(200);

    const files = await Promise.all([core.config.dbPath, `${core.config.dbPath}-wal`].map(readIfExists));
    expect(files[0]?.length).toBeGreaterThan(0);
    for (const f of files) expect(f.includes(key)).toBe(false);
    expect(bodies.join('\n')).not.toContain(key);
    expect(log.join('\n')).not.toContain(key);
  });
});
