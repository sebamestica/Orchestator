/**
 * Plugin Canva: MCP remoto `https://mcp.canva.com/mcp` con OAuth 2.1 (registro dinámico + PKCE S256 + `state`).
 *
 * - `start(redirectUri)`: descubre, registra el cliente (público) y devuelve la URL de autorización. El `state` y el
 *   verificador PKCE viven solo en memoria, son de un solo uso y caducan a los 10 minutos.
 * - `complete(query)`: el navegador vuelve a `GET /plugins/canva/callback` (sin token del núcleo); se valida el
 *   `state`, se canjea el código y se guardan `access_token`, `refresh_token`, `client_id` y la expiración en la
 *   bóveda (DPAPI), en una sola entrada `plugin-canva`.
 * - `accessToken()`: el token vigente, refrescado si le queda poco. Además hay un temporizador que lo refresca antes
 *   de que caduque aunque nadie lo pida.
 * - `disconnect()`: revoca (si el servidor lo permite) y borra la entrada de la bóveda.
 *
 * El token solo vive en la bóveda, en memoria y en el entorno del proceso del agente; nunca en SQLite, eventos ni
 * registros (`knownSecrets()` alimenta el tachado).
 */
import { z } from 'zod';
import { redactSecrets } from '../../shared/index.ts';
import type { SecretVault } from '../vault/index.ts';
import { OAuthError, pkcePair, randomState, type McpOAuth, type OAuthClientInfo, type OAuthServerInfo, type TokenSet } from './oauth.ts';

export const CANVA_MCP_URL = 'https://mcp.canva.com/mcp';
export const CANVA_VAULT_REF = 'plugin-canva';
export const PENDING_TTL_MS = 10 * 60_000;
/** Se refresca cuando queda menos que esto (o menos de la mitad de la vida del token, si es más corta). */
export const DEFAULT_REFRESH_MARGIN_MS = 30 * 60_000;
const MIN_TIMER_MS = 30_000;
const MAX_TIMER_MS = 2_147_000_000;

const serverSchema = z.strictObject({
  resource: z.string(),
  scopes: z.array(z.string()),
  issuer: z.string(),
  authorizationEndpoint: z.string(),
  tokenEndpoint: z.string(),
  registrationEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokenAuthMethods: z.array(z.string()),
});
const clientSchema = z.strictObject({
  clientId: z.string(),
  clientSecret: z.string().optional(),
  redirectUri: z.string(),
  authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
});
const tokensSchema = z.strictObject({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  issuedAt: z.number(),
  scope: z.string().optional(),
});
const storedSchema = z.strictObject({ v: z.literal(1), server: serverSchema, client: clientSchema, tokens: tokensSchema });
type Stored = z.infer<typeof storedSchema>;

interface Pending {
  state: string;
  verifier: string;
  server: OAuthServerInfo;
  client: OAuthClientInfo;
  createdAt: number;
}

export type CallbackQuery = { code?: string | undefined; state?: string | undefined; error?: string | undefined; error_description?: string | undefined };

export type CallbackResult =
  | { ok: true; scope?: string; expiresAt?: number }
  | { ok: false; code: 'invalid_state' | 'expired_state' | 'missing_code' | 'denied' | 'exchange_failed'; message: string; /** El `state` era válido: el intento de conexión terminó. */ consumed: boolean };

export interface CanvaConnectorOptions {
  vault: SecretVault;
  oauth: McpOAuth;
  now?: () => Date;
  refreshMarginMs?: number;
  /** Avisa que la sesión se perdió (refresco rechazado) o se renovó, para actualizar el estado visible. */
  onSessionChange?: (event: { kind: 'refreshed'; expiresAt?: number } | { kind: 'lost'; message: string }) => void;
  log?: (line: string) => void;
}

export class CanvaConnector {
  readonly #opts: CanvaConnectorOptions;
  #pending: Pending | undefined;
  #stored: Stored | undefined;
  #loaded = false;
  #refreshing: Promise<Stored | undefined> | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** Cliente registrado en este arranque (se reutiliza si la redirección no cambia). */
  #client: { client: OAuthClientInfo; issuer: string } | undefined;
  /** Todo token que pasó por aquí en este proceso (para tachar aunque ya no esté vigente). */
  readonly #seen = new Set<string>();

  constructor(opts: CanvaConnectorOptions) {
    this.#opts = opts;
  }

  #now(): number {
    return (this.#opts.now ?? (() => new Date()))().getTime();
  }

  knownSecrets(): string[] {
    return [...this.#seen];
  }

  #remember(...values: (string | undefined)[]): void {
    for (const v of values) if (v && v.length >= 8) this.#seen.add(v);
  }

  /** Hay un intento de conexión vivo (no vencido). */
  pendingAlive(): boolean {
    return this.#pending !== undefined && this.#now() - this.#pending.createdAt < PENDING_TTL_MS;
  }

  async start(redirectUri: string): Promise<{ authUrl: string }> {
    const server = await this.#opts.oauth.discover();
    let client = this.#client?.issuer === server.issuer && this.#client.client.redirectUri === redirectUri ? this.#client.client : undefined;
    if (!client) {
      client = await this.#opts.oauth.register(server, redirectUri);
      this.#client = { client, issuer: server.issuer };
      this.#remember(client.clientSecret);
    }
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    // Un solo intento a la vez: uno nuevo invalida el anterior.
    this.#pending = { state, verifier, server, client, createdAt: this.#now() };
    return { authUrl: this.#opts.oauth.authorizationUrl(server, client, { state, codeChallenge: challenge }) };
  }

  async complete(query: CallbackQuery): Promise<CallbackResult> {
    const pending = this.#pending;
    if (!query.state || !pending || query.state !== pending.state) {
      return { ok: false, code: 'invalid_state', message: 'El enlace no corresponde a un intento de conexión vigente (state desconocido o ya usado).', consumed: false };
    }
    // Un solo uso: se consume antes de cualquier otra cosa.
    this.#pending = undefined;
    if (this.#now() - pending.createdAt >= PENDING_TTL_MS) {
      return { ok: false, code: 'expired_state', message: 'El intento de conexión caducó (10 minutos). Vuelve a pulsar Conectar.', consumed: true };
    }
    if (query.error) {
      const desc = query.error_description ? `: ${redactSecrets(query.error_description).slice(0, 200)}` : '';
      return { ok: false, code: 'denied', message: `Canva no autorizó la conexión (${query.error.slice(0, 60)}${desc}).`, consumed: true };
    }
    if (!query.code) return { ok: false, code: 'missing_code', message: 'Canva volvió sin código de autorización.', consumed: true };
    let tokens: TokenSet;
    try {
      tokens = await this.#opts.oauth.exchangeCode(pending.server, pending.client, { code: query.code, codeVerifier: pending.verifier });
    } catch (err) {
      return { ok: false, code: 'exchange_failed', message: `No se pudo canjear el código: ${this.#errMsg(err, [query.code, pending.verifier])}`, consumed: true };
    }
    this.#remember(tokens.accessToken, tokens.refreshToken);
    const stored: Stored = { v: 1, server: pending.server, client: pending.client, tokens: { ...tokens, issuedAt: this.#now() } };
    await this.#save(stored);
    return { ok: true, ...(tokens.scope ? { scope: tokens.scope } : {}), ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}) };
  }

  /** Hay credenciales guardadas (sin descifrarlas de nuevo si ya están en memoria). */
  async hasSession(): Promise<boolean> {
    return (await this.#load()) !== undefined;
  }

  /** Token vigente (refrescado si hace falta). undefined: no hay sesión o se perdió. */
  async accessToken(): Promise<string | undefined> {
    let stored = await this.#load();
    if (!stored) return undefined;
    if (this.#needsRefresh(stored)) stored = await this.#refresh(stored);
    if (!stored) return undefined;
    if (stored.tokens.expiresAt !== undefined && stored.tokens.expiresAt <= this.#now()) return undefined;
    return stored.tokens.accessToken;
  }

  /** Expiración del token vigente (ms), si se conoce. */
  async expiresAt(): Promise<number | undefined> {
    return (await this.#load())?.tokens.expiresAt;
  }

  async disconnect(): Promise<{ revoked: boolean; hadSession: boolean }> {
    this.#pending = undefined;
    this.#clearTimer();
    const stored = await this.#load().catch(() => undefined);
    let revoked = false;
    if (stored) {
      const { refreshToken, accessToken } = stored.tokens;
      try {
        revoked = await this.#opts.oauth.revoke(stored.server, stored.client, refreshToken ?? accessToken, refreshToken ? 'refresh_token' : 'access_token');
        if (refreshToken) await this.#opts.oauth.revoke(stored.server, stored.client, accessToken, 'access_token').catch(() => false);
      } catch {
        revoked = false;
      }
    }
    await this.#opts.vault.delete(CANVA_VAULT_REF);
    this.#stored = undefined;
    this.#loaded = true;
    return { revoked, hadSession: stored !== undefined };
  }

  close(): void {
    this.#clearTimer();
  }

  #margin(stored: Stored): number {
    const { expiresAt, issuedAt } = stored.tokens;
    const configured = this.#opts.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    if (expiresAt === undefined) return configured;
    return Math.min(configured, Math.max(0, (expiresAt - issuedAt) / 2));
  }

  #needsRefresh(stored: Stored): boolean {
    const { expiresAt, refreshToken } = stored.tokens;
    if (expiresAt === undefined || !refreshToken) return false;
    return expiresAt - this.#now() <= this.#margin(stored);
  }

  /** Refresco en vuelo único. Si el servidor rechaza el refresh token, la sesión se pierde y se borra. */
  #refresh(stored: Stored): Promise<Stored | undefined> {
    this.#refreshing ??= this.#doRefresh(stored).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefresh(stored: Stored): Promise<Stored | undefined> {
    const refreshToken = stored.tokens.refreshToken;
    if (!refreshToken) return stored;
    try {
      const next = await this.#opts.oauth.refresh(stored.server, stored.client, refreshToken);
      this.#remember(next.accessToken, next.refreshToken);
      const updated: Stored = {
        ...stored,
        tokens: { ...next, refreshToken: next.refreshToken ?? refreshToken, issuedAt: this.#now() },
      };
      await this.#save(updated);
      this.#opts.onSessionChange?.({ kind: 'refreshed', ...(updated.tokens.expiresAt ? { expiresAt: updated.tokens.expiresAt } : {}) });
      return updated;
    } catch (err) {
      if (err instanceof OAuthError && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
        await this.#opts.vault.delete(CANVA_VAULT_REF).catch(() => false);
        this.#stored = undefined;
        this.#clearTimer();
        this.#opts.onSessionChange?.({ kind: 'lost', message: 'La sesión de Canva caducó o se revocó: vuelve a conectar.' });
        return undefined;
      }
      // Fallo pasajero (red): se sigue con el token actual mientras no venza y se reintenta más tarde.
      this.#opts.log?.(`canva: no se pudo refrescar el token: ${this.#errMsg(err, [refreshToken])}`);
      this.#schedule(stored, MIN_TIMER_MS * 4);
      return stored;
    }
  }

  async #load(): Promise<Stored | undefined> {
    if (this.#loaded) return this.#stored;
    const raw = await this.#opts.vault.get(CANVA_VAULT_REF);
    let stored: Stored | undefined;
    if (raw !== undefined) {
      try {
        const parsed = storedSchema.safeParse(JSON.parse(raw));
        stored = parsed.success ? parsed.data : undefined;
      } catch {
        stored = undefined;
      }
    }
    // Otro `load` concurrente pudo terminar antes: manda el que ya está en memoria.
    if (!this.#loaded) {
      this.#loaded = true;
      this.#stored = stored;
      if (stored) {
        this.#remember(stored.tokens.accessToken, stored.tokens.refreshToken, stored.client.clientSecret);
        this.#schedule(stored);
      }
    }
    return this.#stored;
  }

  async #save(stored: Stored): Promise<void> {
    await this.#opts.vault.set(CANVA_VAULT_REF, JSON.stringify(stored), { label: 'Plugin Canva (OAuth)' });
    this.#stored = stored;
    this.#loaded = true;
    this.#schedule(stored);
  }

  #schedule(stored: Stored, delayOverride?: number): void {
    this.#clearTimer();
    const { expiresAt, refreshToken } = stored.tokens;
    if (expiresAt === undefined || !refreshToken) return;
    const due = expiresAt - this.#margin(stored) - this.#now();
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, delayOverride ?? due));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const current = this.#stored;
      if (current) void this.#refresh(current);
    }, delay);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #errMsg(err: unknown, extra: readonly string[]): string {
    const msg = err instanceof Error ? err.message : String(err);
    return redactSecrets(msg, [...extra, ...this.#seen]).slice(0, 300);
  }
}
