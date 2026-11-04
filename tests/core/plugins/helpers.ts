import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LockManager } from '../../../src/core/locks/index.ts';
import { PluginService, registerPluginRoutes, type PluginServiceOptions } from '../../../src/core/plugins/index.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken, loopbackHosts, type HubMessage } from '../../../src/core/server/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';

export const PORT = 47811;
export const HOST = `127.0.0.1:${PORT}`;
export const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-mcp.ts', import.meta.url));

/** Lanzador del MCP falso (Node de este proceso) en el modo pedido. */
export function fakeLauncher(mode: string, marker?: string) {
  return { command: process.execPath, args: [FAKE_MCP, mode, ...(marker ? [marker] : [])] };
}

const cleanups: (() => Promise<void> | void)[] = [];
export async function cleanup(): Promise<void> {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}

export async function tempDir(prefix = 'orq-plugins-'): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return d;
}

/** Reloj manual (ms). */
export function manualClock(start = Date.parse('2026-11-04T12:00:00.000Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms), get ms() { return t; } };
}

export interface PluginHarnessOptions extends Partial<Omit<PluginServiceOptions, 'db' | 'vault' | 'locks'>> {
  locksRoot?: string;
}

/** Servicio + app en proceso con almacén en memoria, bóveda en memoria, candados en una carpeta temporal. */
export async function pluginHarness(opts: PluginHarnessOptions = {}) {
  const store = new SqliteStore({ path: ':memory:', timeZone: 'UTC' });
  const vault = new MemoryVault();
  const registry = new AgentRegistry({ store, vault, detectors: [] });
  const hub = new EventHub(store);
  const messages: HubMessage[] = [];
  hub.subscribe((m) => messages.push(m));
  const logs: string[] = [];
  const { locksRoot: givenRoot, ...serviceOpts } = opts;
  const locksRoot = givenRoot ?? (await tempDir('orq-plugins-locks-'));
  const locks = new LockManager({ root: locksRoot });
  const service = new PluginService({
    ...serviceOpts,
    db: store.database,
    vault,
    locks,
    log: (l) => logs.push(l),
    agentKind: (id) => registry.get(id)?.config.kind,
  });
  const token = generateToken();
  const core = createApp({
    token,
    allowedHosts: () => loopbackHosts(PORT),
    store,
    registry,
    hub,
    log: (l) => logs.push(l),
    validateResponses: true,
    routeModules: [(ctx) => registerPluginRoutes(ctx, service)],
  });
  cleanups.push(() => {
    service.close();
    store.close();
  });
  const req = async (method: string, path: string, o: { body?: unknown; token?: string | null; host?: string } = {}) => {
    const headers: Record<string, string> = { host: o.host ?? HOST };
    if (o.token !== null) headers.authorization = `Bearer ${o.token ?? token}`;
    let body: string | undefined;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] = 'application/json';
    }
    const res = await core.app.request(`http://${HOST}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  };
  return { store, vault, registry, hub, messages, logs, locks, locksRoot, service, core, token, req };
}

/** Volcado de todas las tablas de SQLite (para buscar secretos). */
export function dumpDatabase(store: SqliteStore): string {
  const db = store.database;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.map((t) => `${t.name}: ${JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())}`).join('\n');
}

// ------------------------------------------------------------------ OAuth falso

export interface FakeOAuthOptions {
  /** Sin `registration_endpoint`. */
  noRegistration?: boolean;
  /** Sin S256 en `code_challenge_methods_supported`. */
  noS256?: boolean;
  /** PRM con ruta responde 404 (solo existe la raíz). */
  rootOnlyPrm?: boolean;
  /** El PRM declara otro recurso. */
  wrongResource?: boolean;
  expiresIn?: number;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
}

/** Servidor de autorización + recurso MCP falsos en 127.0.0.1, con registro de lo que recibe. */
export async function fakeOAuthServer(opts: FakeOAuthOptions = {}) {
  const log: { method: string; path: string; body: Record<string, string>; json?: unknown }[] = [];
  const codes = new Map<string, Code>();
  const access = new Set<string>();
  const refresh = new Map<string, string>(); // refresh → clientId
  const revoked: string[] = [];
  const clients = new Map<string, { redirectUris: string[] }>();
  const issued: string[] = [];
  let rejectRefresh = false;
  let base = '';
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (d: Buffer) => (data += d.toString('utf8')));
      req.on('end', () => resolve(data));
    });
  const newToken = (kind: string) => {
    const t = `${kind}-${randomBytes(18).toString('hex')}`;
    issued.push(t);
    return t;
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const raw = await readBody(req);
      const form = Object.fromEntries(new URLSearchParams(req.headers['content-type']?.includes('json') ? '' : raw));
      let parsedJson: unknown;
      if (req.headers['content-type']?.includes('json') && raw) parsedJson = JSON.parse(raw);
      log.push({ method: req.method ?? '', path: url.pathname, body: form, ...(parsedJson !== undefined ? { json: parsedJson } : {}) });
      const p = url.pathname;
      if (req.method === 'GET' && p === '/.well-known/oauth-protected-resource/mcp') {
        if (opts.rootOnlyPrm) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { resource: opts.wrongResource ? 'https://otro.example/mcp' : `${base}/mcp`, authorization_servers: [base], scopes_supported: ['design:meta:read', 'profile:read'], bearer_methods_supported: ['header'] });
      }
      if (req.method === 'GET' && p === '/.well-known/oauth-protected-resource') {
        return json(res, 200, { resource: base, authorization_servers: [base], scopes_supported: ['design:meta:read'] });
      }
      if (req.method === 'GET' && p === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(opts.noRegistration ? {} : { registration_endpoint: `${base}/register` }),
          revocation_endpoint: `${base}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
          code_challenge_methods_supported: opts.noS256 ? ['plain'] : ['plain', 'S256'],
        });
      }
      if (req.method === 'POST' && p === '/register') {
        const body = parsedJson as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
        if (!body.redirect_uris?.length) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'At least one redirect URI is required' });
        const id = `cliente-${randomBytes(4).toString('hex')}`;
        clients.set(id, { redirectUris: body.redirect_uris });
        return json(res, 201, { client_id: id, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
      }
      if (req.method === 'GET' && p === '/authorize') {
        // «El usuario acepta»: redirige a la URI registrada con código y el mismo state.
        const q = url.searchParams;
        const clientId = q.get('client_id') ?? '';
        const redirectUri = q.get('redirect_uri') ?? '';
        if (!clients.get(clientId)?.redirectUris.includes(redirectUri)) return json(res, 400, { error: 'invalid_request' });
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'invalid_request' });
        const code = `codigo-${randomBytes(8).toString('hex')}`;
        codes.set(code, { clientId, redirectUri, challenge: q.get('code_challenge') ?? '', resource: q.get('resource') ?? '' });
        const to = new URL(redirectUri);
        to.searchParams.set('code', code);
        to.searchParams.set('state', q.get('state') ?? '');
        res.writeHead(302, { location: to.href });
        return res.end();
      }
      if (req.method === 'POST' && p === '/token') {
        if (form.grant_type === 'authorization_code') {
          const c = codes.get(form.code ?? '');
          codes.delete(form.code ?? '');
          if (!c) return json(res, 400, { error: 'invalid_grant', error_description: 'código desconocido' });
          const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
          if (challenge !== c.challenge || form.client_id !== c.clientId || form.redirect_uri !== c.redirectUri || form.resource !== c.resource) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE, cliente, redirección o recurso no coinciden' });
          }
          const at = newToken('acceso');
          const rt = newToken('refresco');
          access.add(at);
          refresh.set(rt, c.clientId);
          return json(res, 200, { access_token: at, token_type: 'Bearer', expires_in: opts.expiresIn ?? 3600, refresh_token: rt, scope: 'design:meta:read profile:read' });
        }
        if (form.grant_type === 'refresh_token') {
          const owner = refresh.get(form.refresh_token ?? '');
          if (rejectRefresh || !owner || owner !== form.client_id) return json(res, 400, { error: 'invalid_grant', error_description: `refresh token inválido ${form.refresh_token ?? ''}` });
          refresh.delete(form.refresh_token ?? '');
          const at = newToken('acceso');
          const rt = newToken('refresco');
          access.add(at);
          refresh.set(rt, owner);
          return json(res, 200, { access_token: at, token_type: 'bearer', expires_in: opts.expiresIn ?? 3600, refresh_token: rt });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'POST' && p === '/revoke') {
        revoked.push(form.token ?? '');
        refresh.delete(form.token ?? '');
        access.delete(form.token ?? '');
        res.writeHead(200);
        return res.end();
      }
      json(res, 404, { error: 'not_found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('sin puerto');
  base = `http://127.0.0.1:${addr.port}`;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    base,
    mcpUrl: `${base}/mcp`,
    log,
    revoked,
    issued,
    access,
    rejectRefresh: (v = true) => {
      rejectRefresh = v;
    },
    /** Sigue la URL de autorización como el navegador: devuelve la ruta del callback (con código y state). */
    async authorize(authUrl: string): Promise<string> {
      const res = await fetch(authUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== 302 || !location) throw new Error(`authorize respondió ${res.status}`);
      const u = new URL(location);
      return `${u.pathname}${u.search}`;
    },
  };
}
