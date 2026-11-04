/**
 * OAuth 2.1 para servidores MCP remotos, sin dependencias (solo `fetch`), según la especificación de autorización
 * de MCP (2025-06-18): metadatos del recurso protegido (RFC 9728) → metadatos del servidor de autorización
 * (RFC 8414 / OpenID) → registro dinámico del cliente (RFC 7591) → código de autorización con PKCE S256, `state` y
 * `resource` (RFC 8707) → canje, refresco y revocación (RFC 7009).
 *
 * Los tokens nunca se registran: los mensajes de error se tachan con los valores conocidos.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from '../../shared/index.ts';

export interface OAuthServerInfo {
  /** Identificador canónico del recurso (el `resource` de los metadatos), que va en `resource=`. */
  resource: string;
  scopes: string[];
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  tokenAuthMethods: string[];
}

export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** Cómo se autentica el cliente en el endpoint de tokens. */
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Milisegundos desde la época (undefined si el servidor no lo informa). */
  expiresAt?: number;
  scope?: string;
}

/** Interfaz del flujo: la implementación real es `McpOAuthClient`; las pruebas pueden poner otra. */
export interface McpOAuth {
  discover(): Promise<OAuthServerInfo>;
  register(server: OAuthServerInfo, redirectUri: string): Promise<OAuthClientInfo>;
  authorizationUrl(server: OAuthServerInfo, client: OAuthClientInfo, p: { state: string; codeChallenge: string }): string;
  exchangeCode(server: OAuthServerInfo, client: OAuthClientInfo, p: { code: string; codeVerifier: string }): Promise<TokenSet>;
  refresh(server: OAuthServerInfo, client: OAuthClientInfo, refreshToken: string): Promise<TokenSet>;
  /** Revoca si el servidor lo permite. `false`: no hay endpoint o lo rechazó (no es un error). */
  revoke(server: OAuthServerInfo, client: OAuthClientInfo, token: string, hint: 'access_token' | 'refresh_token'): Promise<boolean>;
}

/** `code`: `no_registration` (el servidor no admite registro dinámico), `invalid_grant`, `http`, `metadata`… */
export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}
/** Verificador PKCE (43 caracteres) y su desafío S256. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier, 'ascii').digest()) };
}
export function randomState(): string {
  return base64url(randomBytes(24));
}

const prmSchema = z.looseObject({
  resource: z.string().min(1),
  authorization_servers: z.array(z.string().min(1)).min(1),
  scopes_supported: z.array(z.string()).optional(),
});
const asSchema = z.looseObject({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  registration_endpoint: z.string().min(1).optional(),
  revocation_endpoint: z.string().min(1).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()).optional(),
});
const registrationSchema = z.looseObject({
  client_id: z.string().min(1).max(500),
  client_secret: z.string().min(1).max(2000).optional(),
  token_endpoint_auth_method: z.string().optional(),
});
const tokenSchema = z.looseObject({
  access_token: z.string().min(1).max(12_000),
  token_type: z.string().refine((t) => t.toLowerCase() === 'bearer', 'token_type debe ser Bearer'),
  expires_in: z.coerce.number().positive().optional(),
  refresh_token: z.string().min(1).max(4000).optional(),
  scope: z.string().max(4000).optional(),
});
const oauthErrorSchema = z.looseObject({ error: z.string().max(200), error_description: z.string().max(500).optional() });

export interface McpOAuthClientOptions {
  /** URL del servidor MCP (p. ej. `https://mcp.canva.com/mcp`). */
  resourceUrl: string;
  clientName?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => Date;
}

const isLoopback = (u: URL) => u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';

/** URL https (o http solo hacia el propio equipo, para pruebas y redirecciones). */
function safeUrl(value: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new OAuthError('metadata', `${what}: URL inválida`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u))) throw new OAuthError('metadata', `${what}: se exige https (${u.origin})`);
  if (u.username || u.password) throw new OAuthError('metadata', `${what}: la URL no puede llevar credenciales`);
  return u;
}

/** Igualdad de URLs ignorando la barra final (los metadatos a veces la agregan). */
function sameUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    const u = new URL(s);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

export class McpOAuthClient implements McpOAuth {
  readonly resourceUrl: string;
  private readonly opts: McpOAuthClientOptions;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: McpOAuthClientOptions) {
    this.resourceUrl = safeUrl(opts.resourceUrl, 'Servidor MCP').href;
    this.opts = opts;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  /** PRM con ruta (`/.well-known/oauth-protected-resource/mcp`) y luego en la raíz; después el servidor de autorización. */
  async discover(): Promise<OAuthServerInfo> {
    const res = new URL(this.resourceUrl);
    const path = res.pathname.replace(/\/$/, '');
    const candidates = [
      ...(path ? [{ url: `${res.origin}/.well-known/oauth-protected-resource${path}`, resource: `${res.origin}${path}` }] : []),
      { url: `${res.origin}/.well-known/oauth-protected-resource`, resource: res.origin },
    ];
    let prm: z.infer<typeof prmSchema> | undefined;
    for (const c of candidates) {
      const body = await this.getJson(c.url);
      if (body === undefined) continue;
      const parsed = prmSchema.safeParse(body);
      if (!parsed.success) throw new OAuthError('metadata', `Metadatos del recurso inválidos en ${c.url}`);
      // RFC 9728 §3.3: el recurso declarado debe ser el que se consultó (evita tokens para otro destinatario).
      if (!sameUrl(parsed.data.resource, c.resource)) throw new OAuthError('metadata', `El recurso declarado (${parsed.data.resource}) no coincide con ${c.resource}`);
      prm = parsed.data;
      break;
    }
    if (!prm) throw new OAuthError('metadata', `${res.origin} no publica metadatos de recurso protegido (RFC 9728)`);

    const issuer = safeUrl(prm.authorization_servers[0] ?? '', 'Servidor de autorización');
    const ipath = issuer.pathname.replace(/\/$/, '');
    const asCandidates = ipath
      ? [`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`, `${issuer.origin}/.well-known/openid-configuration${ipath}`, `${issuer.origin}${ipath}/.well-known/openid-configuration`]
      : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
    let as: z.infer<typeof asSchema> | undefined;
    for (const url of asCandidates) {
      const body = await this.getJson(url);
      if (body === undefined) continue;
      const parsed = asSchema.safeParse(body);
      if (!parsed.success) throw new OAuthError('metadata', `Metadatos del servidor de autorización inválidos en ${url}`);
      as = parsed.data;
      break;
    }
    if (!as) throw new OAuthError('metadata', `${issuer.origin} no publica metadatos de autorización (RFC 8414)`);
    if (!sameUrl(as.issuer, issuer.href)) throw new OAuthError('metadata', `El emisor declarado (${as.issuer}) no coincide con ${issuer.href}`);
    // La especificación de MCP exige PKCE S256: si el servidor no lo anuncia, no se sigue.
    if (!(as.code_challenge_methods_supported ?? []).includes('S256')) throw new OAuthError('metadata', 'El servidor de autorización no anuncia PKCE S256');
    return {
      resource: prm.resource,
      scopes: prm.scopes_supported ?? [],
      issuer: as.issuer,
      authorizationEndpoint: safeUrl(as.authorization_endpoint, 'authorization_endpoint').href,
      tokenEndpoint: safeUrl(as.token_endpoint, 'token_endpoint').href,
      ...(as.registration_endpoint ? { registrationEndpoint: safeUrl(new URL(as.registration_endpoint, issuer).href, 'registration_endpoint').href } : {}),
      ...(as.revocation_endpoint ? { revocationEndpoint: safeUrl(new URL(as.revocation_endpoint, issuer).href, 'revocation_endpoint').href } : {}),
      tokenAuthMethods: as.token_endpoint_auth_methods_supported ?? ['client_secret_basic'],
    };
  }

  /** RFC 7591: cliente público (sin secreto) con la redirección de loopback. */
  async register(server: OAuthServerInfo, redirectUri: string): Promise<OAuthClientInfo> {
    if (!server.registrationEndpoint) {
      throw new OAuthError('no_registration', `${server.issuer} no admite registro dinámico de clientes (falta registration_endpoint)`);
    }
    const wantsPublic = server.tokenAuthMethods.includes('none');
    const res = await this.send(server.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: this.opts.clientName ?? 'Orquestador local',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: wantsPublic ? 'none' : 'client_secret_post',
      }),
    });
    const body = await this.readJson(res, 'registro');
    if (!res.ok) throw this.errorFrom(res.status, body, 'registro');
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) throw new OAuthError('metadata', 'Respuesta de registro inválida');
    const secret = parsed.data.client_secret;
    const method = parsed.data.token_endpoint_auth_method;
    const authMethod: OAuthClientInfo['authMethod'] = !secret
      ? 'none'
      : method === 'client_secret_basic' || (method !== 'client_secret_post' && !server.tokenAuthMethods.includes('client_secret_post'))
        ? 'client_secret_basic'
        : 'client_secret_post';
    return { clientId: parsed.data.client_id, ...(secret ? { clientSecret: secret } : {}), redirectUri, authMethod };
  }

  authorizationUrl(server: OAuthServerInfo, client: OAuthClientInfo, p: { state: string; codeChallenge: string }): string {
    const url = new URL(server.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', client.redirectUri);
    url.searchParams.set('code_challenge', p.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', p.state);
    url.searchParams.set('resource', server.resource);
    if (server.scopes.length > 0) url.searchParams.set('scope', server.scopes.join(' '));
    return url.href;
  }

  exchangeCode(server: OAuthServerInfo, client: OAuthClientInfo, p: { code: string; codeVerifier: string }): Promise<TokenSet> {
    return this.token(server, client, {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: client.redirectUri,
      code_verifier: p.codeVerifier,
      resource: server.resource,
    }, [p.code, p.codeVerifier]);
  }

  refresh(server: OAuthServerInfo, client: OAuthClientInfo, refreshToken: string): Promise<TokenSet> {
    return this.token(server, client, { grant_type: 'refresh_token', refresh_token: refreshToken, resource: server.resource }, [refreshToken]);
  }

  async revoke(server: OAuthServerInfo, client: OAuthClientInfo, token: string, hint: 'access_token' | 'refresh_token'): Promise<boolean> {
    if (!server.revocationEndpoint) return false;
    const { headers, extra } = this.clientAuth(client);
    try {
      const res = await this.send(server.revocationEndpoint, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ token, token_type_hint: hint, ...extra }).toString(),
      }, [token]);
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async token(server: OAuthServerInfo, client: OAuthClientInfo, params: Record<string, string>, secrets: readonly string[]): Promise<TokenSet> {
    const { headers, extra } = this.clientAuth(client);
    const res = await this.send(server.tokenEndpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ ...params, ...extra }).toString(),
    }, secrets);
    const body = await this.readJson(res, 'token');
    if (!res.ok) throw this.errorFrom(res.status, body, 'token');
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) throw new OAuthError('metadata', 'Respuesta del endpoint de tokens inválida');
    const now = (this.opts.now ?? (() => new Date()))().getTime();
    const t = parsed.data;
    return {
      accessToken: t.access_token,
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      ...(t.expires_in ? { expiresAt: now + t.expires_in * 1000 } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
    };
  }

  private clientAuth(client: OAuthClientInfo): { headers: Record<string, string>; extra: Record<string, string> } {
    if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
      const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64');
      return { headers: { authorization: `Basic ${basic}` }, extra: {} };
    }
    if (client.authMethod === 'client_secret_post' && client.clientSecret) return { headers: {}, extra: { client_id: client.clientId, client_secret: client.clientSecret } };
    return { headers: {}, extra: { client_id: client.clientId } };
  }

  /** GET de JSON: undefined si 404/405 (se prueba el siguiente candidato). */
  private async getJson(url: string): Promise<unknown> {
    const res = await this.send(url, { method: 'GET', headers: { accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' } });
    if (res.status === 404 || res.status === 405) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const body = await this.readJson(res, url);
    if (!res.ok) throw new OAuthError('http', `${url} respondió HTTP ${res.status}`);
    return body;
  }

  private async send(url: string, init: RequestInit, secrets: readonly string[] = []): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new OAuthError('network', redactSecrets(`No se pudo contactar ${new URL(url).origin}: ${msg}`, secrets).slice(0, 300));
    }
  }

  private async readJson(res: Response, what: string): Promise<unknown> {
    const text = await res.text().catch(() => '');
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (res.ok) throw new OAuthError('metadata', `Respuesta no JSON (${what})`);
      return undefined;
    }
  }

  private errorFrom(status: number, body: unknown, what: string): OAuthError {
    const e = oauthErrorSchema.safeParse(body);
    if (!e.success) return new OAuthError('http', `${what}: HTTP ${status}`);
    const desc = e.data.error_description ? `: ${redactSecrets(e.data.error_description).slice(0, 200)}` : '';
    return new OAuthError(e.data.error === 'invalid_grant' ? 'invalid_grant' : e.data.error.slice(0, 60), `${what}: ${e.data.error}${desc}`);
  }
}
