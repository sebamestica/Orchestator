import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createF5ServerRoutes, type F5ServerOptions } from '../../../src/core/app/f5-servidor.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, loopbackHosts, type HubMessage, type TaskHooks } from '../../../src/core/server/index.ts';
import { SqliteStore, type TaskRecord } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { agentConfigSchema, type AgentKind, type ProbeResult } from '../../../src/shared/index.ts';

export const PORT = 47811;
export const HOST = `127.0.0.1:${PORT}`;

const dirs: string[] = [];

/** Carpeta temporal real (se borra en `cleanupDirs`). */
export async function tempDir(prefix = 'orq-c14-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export async function cleanupDirs(): Promise<void> {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Escribe archivos (rutas relativas a `root`, con carpetas intermedias). */
export async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
}

/** Repositorio git real (vacío) con la rama inicial indicada. */
export function gitInit(dir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore', windowsHide: true });
}

/** Repo git con un commit vacío (sin commits no hay worktrees: el núcleo lo registraría en modo local). */
export function gitInitWithCommit(dir: string, branch = 'main'): void {
  gitInit(dir, branch);
  execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@l', 'commit', '-q', '--allow-empty', '-m', 'inicio'], { cwd: dir, stdio: 'ignore', windowsHide: true });
}

export function putAgent(store: SqliteStore, id: string, kind: AgentKind, extra: { enabled?: boolean; models?: string[]; model?: string } = {}): void {
  const provider = kind === 'claude-sdk' || kind === 'api' ? 'anthropic' : kind === 'codex-cli' ? 'codex' : 'antigravity';
  const config = agentConfigSchema.parse({
    id,
    kind,
    provider,
    displayName: `Agente ${id}`,
    enabled: extra.enabled ?? true,
    ...(extra.model ? { model: extra.model } : {}),
  });
  const lastProbe: ProbeResult | null = extra.models
    ? { agentId: id, installed: true, authenticated: true, models: extra.models, quotaMethod: 'none', warnings: [] }
    : null;
  store.putAgent({ config, lastProbe });
}

export interface F5TestApp {
  token: string;
  store: SqliteStore;
  registry: AgentRegistry;
  hub: EventHub;
  messages: HubMessage[];
  approved: TaskRecord[];
  req(method: string, path: string, o?: ReqOptions): Promise<{ status: number; headers: Headers; text: string; json: unknown }>;
}

export interface ReqOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** `null`: sin `Authorization`. */
  token?: string | null;
}

/** App en proceso con el módulo de c14, almacén en memoria y ganchos de tareas que registran las aprobaciones. */
export function makeF5App(opts: F5ServerOptions & { allowedOrigins?: string[]; tasks?: TaskHooks } = {}): F5TestApp {
  const token = generateToken();
  const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
  const registry = new AgentRegistry({ store, vault: new MemoryVault(), detectors: [] });
  const hub = new EventHub(store);
  const messages: HubMessage[] = [];
  hub.subscribe((m) => messages.push(m));
  const approved: TaskRecord[] = [];
  const tasks: TaskHooks = opts.tasks ?? { onApproved: (t) => void approved.push(t) };
  const { allowedOrigins, tasks: _t, ...moduleOpts } = opts;
  const core = createApp({
    token,
    allowedHosts: () => loopbackHosts(PORT),
    ...(allowedOrigins ? { allowedOrigins } : {}),
    store,
    registry,
    hub,
    tasks,
    validateResponses: true,
    routeModules: [createF5ServerRoutes(moduleOpts)],
  });
  const req: F5TestApp['req'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { host: HOST };
    if (o.token !== null) headers.authorization = `Bearer ${o.token ?? token}`;
    let body: string | undefined;
    if (o.body !== undefined) {
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
    return { status: res.status, headers: res.headers, text, json };
  };
  return { token, store, registry, hub, messages, approved, req };
}
