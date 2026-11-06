import { randomBytes } from 'node:crypto';
import type { AgentAdapter, AgentConfig, AgentEvent, MemoryStore, ProbeResult, QuotaSnapshot, TaskBrief } from '../../../src/shared/index.ts';
import { AgentRegistry, QuotaRefresher, type AdapterFactory, type CliDetector, type QuotaProviderFactory } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, loopbackHosts, type Planner, type SkillsService, type TaskHooks } from '../../../src/core/server/index.ts';
import { SqliteStore, type QuotaRecord } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';

export const PORT = 47811;
export const HOST = `127.0.0.1:${PORT}`;

/** Clave falsa con forma real (se genera en cada ejecución; nunca es una clave de verdad). */
export function fakeKey(prefix = 'sk-ant-api03-'): string {
  return `${prefix}${randomBytes(24).toString('hex')}`;
}

export interface FakeAdapterLog {
  probes: { config: AgentConfig; apiKey: string | undefined }[];
}

/**
 * Fábrica de adaptadores falsa. Autentica solo si la clave es `validKey` (o si el agente no usa clave).
 * Adversaria: el probe intenta filtrar la clave en sus advertencias para comprobar el tachado.
 */
export function fakeAdapterFactory(validKey: string, log: FakeAdapterLog = { probes: [] }): AdapterFactory {
  return (config, secrets) => {
    const adapter: AgentAdapter = {
      config,
      async probe(): Promise<ProbeResult> {
        log.probes.push({ config, apiKey: secrets.apiKey });
        if (secrets.apiKey === 'sk-ant-explota-' + validKey.slice(-12)) throw new Error(`fallo con la clave ${secrets.apiKey}`);
        const ok = config.secretRef ? secrets.apiKey === validKey : true;
        return {
          agentId: config.id,
          installed: true,
          authenticated: ok,
          version: '1.0.0',
          models: ['modelo-a', 'modelo-b'],
          quotaMethod: config.kind === 'codex-cli' ? 'codex-ratelimits' : 'manual-budget',
          warnings: [`probado con ${secrets.apiKey ?? 'sin clave'}`],
        };
      },
      async *run(): AsyncIterable<AgentEvent> {
        // no se usa en estas pruebas
      },
    };
    return adapter;
  };
}

export function fakeQuotaFactory(): QuotaProviderFactory {
  return (agent, getSecrets) => ({
    agentId: agent.config.id,
    async read(): Promise<QuotaSnapshot> {
      if (agent.config.id.startsWith('roto')) throw new Error(`lector caído; clave ${(await getSecrets()).apiKey ?? ''}`);
      return {
        agentId: agent.config.id,
        method: agent.quotaMethod ?? 'none',
        takenAt: '2026-11-01T20:00:00.000Z',
        buckets: [{ groupId: 'g', groupName: 'Grupo', window: '5h', remainingFraction: 0.75, resetAt: '2026-11-02T01:00:00.000Z' }],
        stale: false,
      };
    },
  });
}

export function fakePlanner(): Planner & { calls: { projectId: string; text: string; knownTaskIds: string[] }[] } {
  const calls: { projectId: string; text: string; knownTaskIds: string[] }[] = [];
  return {
    calls,
    async plan(input) {
      calls.push({ projectId: input.projectId, text: input.text, knownTaskIds: input.knownTaskIds });
      if (input.text.includes('CICLO')) {
        return { ok: false, issues: [{ code: 'cycle', message: 'a → b → a', taskIds: ['a', 'b'] }], attempts: 3 };
      }
      const mk = (id: string, deps: string[]): TaskBrief => ({
        id,
        projectId: input.projectId,
        title: `Tarea ${id}`,
        objective: `Objetivo ${id}`,
        ownedPaths: [`src/${id}/**`],
        dependsOn: deps,
        acceptance: ['pruebas en verde'],
        difficulty: 'low',
        contextRefs: [],
        skillRefs: [],
      });
      const suffix = randomBytes(2).toString('hex');
      return { ok: true, tasks: [mk(`a-${suffix}`, []), mk(`b-${suffix}`, [`a-${suffix}`])], attempts: 1 };
    },
  };
}

export function fakeSkills(): SkillsService {
  return {
    async list() {
      return [{ name: 'flota-orquestador', root: 'C:\\dev\\agent-hub\\skills', description: 'Reglas de la flota' }];
    },
    async importSkill(source) {
      if (source.includes('no-existe')) throw Object.assign(new Error('origen no encontrado'), { code: 'ENOENT' });
      return { name: 'nueva', quarantinePath: 'C:\\dev\\agent-hub\\skills-entrantes\\nueva-1', files: [{ path: 'SKILL.md', sha256: 'ab'.repeat(32) }] };
    },
    async approve(name) {
      return { name, approved: true };
    },
    async reject(name) {
      return { name, rejected: true };
    },
  };
}

export function fakeMemory(): MemoryStore & { calls: { projectId: string; taskId: string; budget: number }[] } {
  const calls: { projectId: string; taskId: string; budget: number }[] = [];
  return {
    calls,
    async buildContext(projectId, task, budgetChars) {
      calls.push({ projectId, taskId: task.id, budget: budgetChars });
      return `# ${projectId}\nResumen para ${task.title}`.slice(0, budgetChars);
    },
    async recordSession() {
      // no se usa
    },
  };
}

export interface TestAppOptions {
  validKey?: string;
  detectors?: CliDetector[];
  withServices?: boolean;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  /** Ganchos de orquestación propios (por defecto, unos que solo anotan las llamadas en `hookCalls`). */
  tasks?: TaskHooks;
}

/** App en proceso (`app.request`) con almacén en memoria y servicios falsos. */
export function makeTestApp(opts: TestAppOptions = {}) {
  const validKey = opts.validKey ?? fakeKey();
  const token = generateToken();
  const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
  const vault = new MemoryVault();
  const adapterLog: FakeAdapterLog = { probes: [] };
  const withServices = opts.withServices ?? true;
  const registry = new AgentRegistry({
    store,
    vault,
    ...(withServices ? { adapterFactory: fakeAdapterFactory(validKey, adapterLog) } : {}),
    detectors: opts.detectors ?? [],
  });
  const hub = new EventHub(store);
  const quotas = new QuotaRefresher<QuotaRecord>({ registry, factory: fakeQuotaFactory(), publish: (s) => hub.publishQuota(s) });
  const planner = fakePlanner();
  const memory = fakeMemory();
  const hookCalls: { approved: string[]; cancelled: string[] } = { approved: [], cancelled: [] };
  const tasks: TaskHooks = opts.tasks ?? {
    onApproved: (t) => {
      hookCalls.approved.push(t.task.id);
    },
    onCancel: (t) => {
      hookCalls.cancelled.push(t.task.id);
    },
  };
  const logLines: string[] = [];
  const core = createApp({
    token,
    allowedHosts: () => loopbackHosts(PORT),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    store,
    registry,
    hub,
    ...(withServices ? { quotas, planner, skills: fakeSkills(), memory, tasks } : {}),
    log: (l) => logLines.push(l),
    validateResponses: true,
    ...(opts.maxBodyBytes ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  });

  interface ReqOptions {
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    /** `null` = sin encabezado Authorization. */
    token?: string | null;
    host?: string | null;
  }
  const req = async (method: string, path: string, o: ReqOptions = {}) => {
    const headers: Record<string, string> = {};
    if (o.host !== null) headers.host = o.host ?? HOST;
    if (o.token !== null) headers.authorization = `Bearer ${o.token ?? token}`;
    let body: string | undefined;
    if (o.rawBody !== undefined) body = o.rawBody;
    else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] = 'application/json';
    }
    Object.assign(headers, o.headers ?? {});
    const res = await core.app.request(`http://${HOST}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json: json as Record<string, unknown> };
  };

  return { core, app: core.app, routes: core.routes, req, token, store, vault, registry, hub, planner, memory, hookCalls, logLines, adapterLog, validKey };
}

/** Sustituye `:param` por valores de ejemplo para recorrer rutas. */
export function fillPath(path: string, values: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => values[name] ?? 'x-no-existe');
}
