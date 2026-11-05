/** Utilidades de las pruebas del resumen de uso: app real en proceso con el módulo de rutas y datos sembrados. */
import { readFileSync } from 'node:fs';
import { ClaudeSdkTranslator } from '../../../src/core/adapters/claude-sdk/index.ts';
import { CHAT_SCHEMA } from '../../../src/core/chat/db.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, loopbackHosts } from '../../../src/core/server/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { createUsageRoutes } from '../../../src/core/usage-stats/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import type { AgentConfig, AgentEvent, TaskBrief, Usage } from '../../../src/shared/index.ts';

export const TZ = 'America/Santiago';
/** «Ahora» de las pruebas: 2026-11-04 22:00 en Santiago (UTC−3). */
export const NOW = new Date('2026-11-05T01:00:00.000Z');
const PORT = 47811;
const HOST = `127.0.0.1:${PORT}`;

export function makeUsageApp(opts: { now?: Date } = {}) {
  const now = () => opts.now ?? NOW;
  const store = new SqliteStore({ path: ':memory:', timeZone: TZ, now });
  const registry = new AgentRegistry({ store, vault: new MemoryVault(), detectors: [] });
  const hub = new EventHub(store);
  const token = generateToken();
  const core = createApp({
    token,
    allowedHosts: () => loopbackHosts(PORT),
    store,
    registry,
    hub,
    now,
    routeModules: [createUsageRoutes({ timeZone: TZ, mindAgentId: 'orquestador' })],
    validateResponses: true,
  });
  const req = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { host: HOST, authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await core.app.request(`http://${HOST}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as unknown };
  };
  return { store, core, req, close: () => store.close() };
}

const AGENTS: AgentConfig[] = [
  { id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Claude', quotaFloor: 0.2, enabled: true },
  { id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex CLI', quotaFloor: 0.2, enabled: true },
  { id: 'agy', kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity (agy)', quotaFloor: 0.2, enabled: true },
];

export function seedAgents(store: SqliteStore): void {
  for (const config of AGENTS) store.putAgent({ config });
}

export function task(id: string, projectId: string): TaskBrief {
  return {
    id,
    projectId,
    title: `Tarea ${id}`,
    objective: 'Objetivo',
    ownedPaths: ['src/**'],
    dependsOn: [],
    acceptance: ['pruebas en verde'],
    difficulty: 'low',
    contextRefs: [],
    skillRefs: [],
  };
}

/** Chat con la mente sobre un proyecto (la tabla es del módulo de chats). */
export function seedChat(store: SqliteStore, sessionId: string, projectId: string | null): void {
  store.database.exec(CHAT_SCHEMA);
  store.database
    .prepare(
      `INSERT INTO chat_chats (id, project_id, title, cwd, extra_roots_json, mode, mind_agent_id, session_id, state, cost_usd, created_at, updated_at)
       VALUES (?, ?, 'Chat', 'C:\\dev\\x', '[]', 'plan', 'claude', ?, 'idle', 0, ?, ?)`,
    )
    .run(`chat_${sessionId.slice(-8)}`, projectId, sessionId, NOW.toISOString(), NOW.toISOString());
}

let seq = 0;
export function usage(sessionId: string, agentId: string, ts: string, payload: Usage): AgentEvent {
  return { sessionId, agentId, seq: seq++, ts, type: 'usage', payload };
}

const jsonl = (rel: string): unknown[] =>
  readFileSync(new URL(`../../../fixtures/${rel}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);

/** Eventos `usage` reales de Claude: la ejecución con subagente de `fixtures/claude-sdk/subagent-run.jsonl`. */
export function claudeRunUsage(sessionId: string, ts: string, agentId = 'claude'): AgentEvent[] {
  const tr = new ClaudeSdkTranslator({ agentId, sessionId, now: () => new Date(ts) });
  return jsonl('claude-sdk/subagent-run.jsonl')
    .flatMap((m) => tr.translate(m))
    .filter((e) => e.type === 'usage');
}

/** Suma de una columna de `usage` (para cuadrar el resumen con la tabla). */
export function sumUsage(store: SqliteStore, column: string, where = '1 = 1'): number {
  const row = store.database.prepare(`SELECT COALESCE(SUM(${column}), 0) AS n FROM usage WHERE ${where}`).get();
  return Number(row?.n ?? 0);
}
