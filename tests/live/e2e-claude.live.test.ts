import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { removeDir } from '../../src/core/app/cli-commands.ts';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { runSmokeTask } from '../../src/core/app/smoke.ts';
import { startCore, type Core } from '../../src/core/main.ts';
import type { AgentEvent } from '../../src/shared/index.ts';

/**
 * Criterio principal de c12 (gasta saldo: una tarea mínima, esfuerzo bajo y tope de 1 USD). La clave entra por la
 * API local, queda solo en la bóveda DPAPI y Claude trabaja con ella después de borrar las variables del proceso.
 * Solo en Windows, con ORQ_LIVE=1 y la clave en el entorno. Desde WSL (WSLENV con /w, no /u):
 *   WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/e2e-claude.live.test.ts"
 */
const live = process.env.ORQ_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY && process.platform === 'win32';
const AGENT = 'claude-e2e';

describe.skipIf(!live)('e2e: Claude con la clave de la bóveda', () => {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const dirs: string[] = [];
  const log: string[] = [];
  let comp: Composition | undefined;
  let core: Core | undefined;

  afterAll(async () => {
    process.env.ANTHROPIC_API_KEY = key;
    if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl;
    await core?.stop();
    comp?.close();
    for (const d of dirs) if (!(await removeDir(d))) console.warn(`No se pudo borrar ${d}`);
  }, 30_000);

  it('POST /agents → bóveda DPAPI → Supervisor + envFor sin variables de entorno → uso en SQLite', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orq-e2e-datos-'));
    const repo = mkdtempSync(join(tmpdir(), 'orq-e2e-repo-'));
    dirs.push(dataDir, repo);
    comp = compose({
      env: { ORQ_DATA_DIR: dataDir },
      config: { port: 0, quotaRefreshMs: 0 },
      memoryDir: join(dataDir, 'memoria'),
      skillsHubDir: join(dataDir, 'hub'),
      projectDir: repo,
      detectors: [],
      claude: { extraOptions: { maxTurns: 4, effort: 'low' } },
      log: (l) => log.push(l),
    });
    core = await startCore(comp.deps);
    const c = core;
    const bodies: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${c.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${c.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      bodies.push(text);
      return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
    };

    // 1. La clave entra por la API local; el probe la prueba contra la URL del usuario.
    const added = await call('POST', '/agents', { provider: 'anthropic', apiKey: key, ...(baseUrl ? { baseUrl } : {}), displayName: 'Claude e2e', id: AGENT, budgetUsd: 1 });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ agent: { config: { id: AGENT, kind: 'claude-sdk', budgetUsd: 1 } }, probe: { authenticated: true } });

    // 2. Sin variables de entorno: de aquí en adelante la clave solo puede salir de la bóveda.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    // 3. Repo git temporal y tarea mínima con Supervisor + envFor.
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# Repo de prueba e2e\n');
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=orq', '-c', 'user.email=orq@localhost', ...args], { cwd: repo, encoding: 'utf8' });
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-q', '-m', 'inicio']]) expect(git(...args).status).toBe(0);

    const adapter = await c.registry.createAdapter(AGENT);
    await comp.env.load(AGENT);
    const t0 = Date.now();
    const r = await runSmokeTask({ adapter, envFor: comp.envFor, sink: c.hub, worktreePath: repo, timeoutMs: 240_000 });
    const attempt = r.attempt;
    console.warn(JSON.stringify({ segundos: (Date.now() - t0) / 1000, resultado: r.run.outcome, texto: r.text, uso: attempt?.usage, error: attempt?.error }));
    expect(r.run.ok).toBe(true);
    expect(r.text).toMatch(/\bOK\b/);

    // 4. Eventos por la API: done ok y un text con OK.
    const sessionId = attempt?.sessionId ?? '';
    const events = await call('GET', `/sessions/${encodeURIComponent(sessionId)}/events?since=-1&limit=5000`);
    expect(events.status).toBe(200);
    const list = events.json.events as AgentEvent[];
    expect(list.some((e) => e.type === 'done' && e.payload.ok)).toBe(true);
    expect(list.some((e) => e.type === 'text' && /\bOK\b/.test(e.payload.text))).toBe(true);

    // 5. Consumo en SQLite: costo > 0 para ese agente.
    const usage = await call('GET', `/usage?groupBy=agent&agentId=${AGENT}`);
    const row = (usage.json.rows as { agentId: string; costUsd: number }[])[0];
    expect(row?.agentId).toBe(AGENT);
    expect(row?.costUsd).toBeGreaterThan(0);
    expect((await call('GET', '/agents')).status).toBe(200);
    expect((await call('GET', `/sessions?agentId=${AGENT}`)).status).toBe(200);

    // 6. La clave no está en vault.json (cifrada con DPAPI), ni en el .db ni en el -wal, ni en respuestas o registros.
    const vaultText = readFileSync(c.config.vaultPath, 'utf8');
    expect(vaultText).toContain('"scheme": "dpapi-currentuser"');
    expect(vaultText).not.toContain(key);
    const db = readFileSync(c.config.dbPath);
    expect(db.length).toBeGreaterThan(0);
    expect(db.includes(key)).toBe(false);
    let wal = Buffer.alloc(0);
    try {
      wal = readFileSync(`${c.config.dbPath}-wal`);
    } catch {
      /* sin -wal: nada que revisar */
    }
    expect(wal.includes(key)).toBe(false);
    expect(bodies.join('\n')).not.toContain(key);
    expect(log.join('\n')).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain(key);
  }, 300_000);
});
