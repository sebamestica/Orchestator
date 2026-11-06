import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANVA_VAULT_REF, McpOAuthClient, OAuthError, PluginStateStore } from '../../../src/core/plugins/index.ts';
import type { Plugin } from '../../../src/shared/index.ts';
import { cleanup, dumpDatabase, fakeOAuthServer, manualClock, pluginHarness, type FakeOAuthOptions } from './helpers.ts';

afterEach(cleanup);

async function canvaHarness(opts: FakeOAuthOptions = {}, fetch?: typeof globalThis.fetch) {
  const oauth = await fakeOAuthServer(opts);
  const clock = manualClock();
  const h = await pluginHarness({ now: clock.now, canva: { mcpUrl: oauth.mcpUrl, ...(fetch ? { fetch } : {}) } });
  return { ...h, oauth, clock };
}

/** `fetch` que, con `net.offline`, falla como sin red en las renovaciones (`grant_type=refresh_token`). */
function flakyRefreshFetch(net: { offline: boolean }): typeof globalThis.fetch {
  return (input, init) => {
    if (net.offline && String(init?.body ?? '').includes('grant_type=refresh_token')) return Promise.reject(new TypeError('fetch failed'));
    return globalThis.fetch(input, init);
  };
}

async function storedAccessToken(h: Awaited<ReturnType<typeof canvaHarness>>): Promise<string | undefined> {
  const raw = await h.vault.get(CANVA_VAULT_REF);
  return raw ? (JSON.parse(raw) as { tokens: { accessToken: string } }).tokens.accessToken : undefined;
}

async function connectCanva(h: Awaited<ReturnType<typeof canvaHarness>>) {
  const res = await h.req('POST', '/plugins/canva/connect', { body: {} });
  expect(res.status).toBe(200);
  const plugin = (res.json as { plugin: Plugin }).plugin;
  expect(plugin.status).toBe('connecting');
  expect(plugin.authUrl).toBeDefined();
  return plugin;
}

describe('OAuth de MCP: descubrimiento (servidor falso)', () => {
  it('PRM con ruta, metadatos del servidor y comprobaciones', async () => {
    const oauth = await fakeOAuthServer();
    const info = await new McpOAuthClient({ resourceUrl: oauth.mcpUrl }).discover();
    expect(info).toEqual({
      resource: oauth.mcpUrl,
      scopes: ['design:meta:read', 'profile:read'],
      issuer: oauth.base,
      authorizationEndpoint: `${oauth.base}/authorize`,
      tokenEndpoint: `${oauth.base}/token`,
      registrationEndpoint: `${oauth.base}/register`,
      revocationEndpoint: `${oauth.base}/revoke`,
      tokenAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    });
    expect(oauth.log.map((l) => l.path)).toEqual(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']);
  });

  it('sin PRM con ruta usa el de la raíz', async () => {
    const oauth = await fakeOAuthServer({ rootOnlyPrm: true });
    const info = await new McpOAuthClient({ resourceUrl: oauth.mcpUrl }).discover();
    expect(info.resource).toBe(oauth.base);
    expect(oauth.log.map((l) => l.path).slice(0, 2)).toEqual(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
  });

  it('rechaza un recurso declarado distinto y un servidor sin S256', async () => {
    const wrong = await fakeOAuthServer({ wrongResource: true });
    await expect(new McpOAuthClient({ resourceUrl: wrong.mcpUrl }).discover()).rejects.toThrow(/no coincide/);
    const plain = await fakeOAuthServer({ noS256: true });
    await expect(new McpOAuthClient({ resourceUrl: plain.mcpUrl }).discover()).rejects.toThrow(/S256/);
  });

  it('exige https salvo hacia el propio equipo', () => {
    expect(() => new McpOAuthClient({ resourceUrl: 'http://mcp.canva.com/mcp' })).toThrow(OAuthError);
    expect(() => new McpOAuthClient({ resourceUrl: 'https://mcp.canva.com/mcp' })).not.toThrow();
  });

  it('sin registro dinámico: estado error con el bloqueo explicado', async () => {
    const h = await canvaHarness({ noRegistration: true });
    const { plugin } = (await h.req('POST', '/plugins/canva/connect', { body: {} })).json as { plugin: Plugin };
    expect(plugin.status).toBe('error');
    expect(plugin.detail).toContain('no admite registro dinámico');
    expect(plugin.steps[0]).toContain('client_id registrado a mano');
  });
});

describe('OAuth de Canva de punta a punta (servidor falso)', () => {
  it('connect → authUrl con PKCE/state/resource → callback sin token → tokens en la bóveda → entrega como MCP http', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    const auth = new URL(plugin.authUrl ?? '');
    expect(auth.origin + auth.pathname).toBe(`${h.oauth.base}/authorize`);
    const q = auth.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:47811/plugins/canva/callback');
    expect(q.get('resource')).toBe(h.oauth.mcpUrl);
    expect(q.get('scope')).toBe('design:meta:read profile:read');
    const reg = h.oauth.log.find((l) => l.path === '/register');
    expect(reg?.json).toEqual({
      client_name: 'Berland',
      redirect_uris: ['http://127.0.0.1:47811/plugins/canva/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    // GET /plugins también lo devuelve mientras el intento está vivo.
    expect(((await h.req('GET', '/plugins')).json as { plugins: Plugin[] }).plugins[1]?.authUrl).toBe(plugin.authUrl);

    const callback = await h.oauth.authorize(plugin.authUrl ?? '');
    const page = await h.req('GET', callback, { token: null });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.text).toContain('Canva conectado, ya puedes cerrar esta pestaña.');

    const tokenReq = h.oauth.log.find((l) => l.path === '/token');
    expect(tokenReq?.body).toMatchObject({ grant_type: 'authorization_code', redirect_uri: 'http://127.0.0.1:47811/plugins/canva/callback', resource: h.oauth.mcpUrl });
    expect(tokenReq?.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const status = h.service.status('canva');
    expect(status).toMatchObject({ status: 'connected', steps: [] });
    expect(status.authUrl).toBeUndefined();
    expect(status.detail).toContain('Cuenta de Canva conectada por OAuth');

    const stored = JSON.parse((await h.vault.get(CANVA_VAULT_REF)) ?? '{}') as { client: { clientId: string }; tokens: { accessToken: string; refreshToken: string; expiresAt: number } };
    const [access, refresh] = h.oauth.issued;
    expect(stored.tokens).toMatchObject({ accessToken: access, refreshToken: refresh, expiresAt: h.clock.ms + 3600_000 });
    expect(stored.client.clientId).toMatch(/^cliente-/);

    const servers = await h.service.mcpServersFor('claude-main', 'claude-sdk');
    expect(servers.canva).toMatchObject({ type: 'http', url: h.oauth.mcpUrl, headers: { Authorization: `Bearer ${access ?? ''}` } });
    expect(await h.service.mcpServersFor('agy-main', 'agy-cli')).toEqual({});
  });

  it('state de un solo uso: repetir el callback no cambia nada', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    const callback = await h.oauth.authorize(plugin.authUrl ?? '');
    expect((await h.req('GET', callback, { token: null })).status).toBe(200);
    const again = await h.req('GET', callback, { token: null });
    expect(again.status).toBe(400);
    expect(again.text).toContain('state desconocido o ya usado');
    expect(h.service.status('canva').status).toBe('connected');
  });

  it('state inventado: 400 y el intento sigue vivo', async () => {
    const h = await canvaHarness();
    await connectCanva(h);
    const bad = await h.req('GET', '/plugins/canva/callback?code=x&state=inventado', { token: null });
    expect(bad.status).toBe(400);
    expect(h.service.status('canva').status).toBe('connecting');
    expect(h.oauth.log.some((l) => l.path === '/token')).toBe(false);
  });

  it('state vencido (más de 10 minutos): 400, no canjea y queda en error', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    const callback = await h.oauth.authorize(plugin.authUrl ?? '');
    h.clock.advance(10 * 60_000 + 1);
    expect(h.service.status('canva')).toMatchObject({ status: 'disconnected' });
    expect(h.service.status('canva').authUrl).toBeUndefined();
    const res = await h.req('GET', callback, { token: null });
    expect(res.status).toBe(400);
    expect(res.text).toContain('caducó');
    expect(h.oauth.log.some((l) => l.path === '/token')).toBe(false);
    expect(h.service.status('canva').status).toBe('error');
  });

  it('el usuario rechaza en Canva: error visible', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    const state = new URL(plugin.authUrl ?? '').searchParams.get('state') ?? '';
    const res = await h.req('GET', `/plugins/canva/callback?error=access_denied&error_description=El%20usuario%20cancel%C3%B3&state=${state}`, { token: null });
    expect(res.status).toBe(400);
    expect(h.service.status('canva')).toMatchObject({ status: 'error' });
    expect(h.service.status('canva').detail).toContain('access_denied');
  });

  it('solo el callback va sin token: el resto de /plugins sigue exigiéndolo', async () => {
    const h = await canvaHarness();
    expect((await h.req('GET', '/plugins', { token: null })).status).toBe(401);
    expect((await h.req('POST', '/plugins/canva/connect', { token: null, body: {} })).status).toBe(401);
    expect((await h.req('POST', '/plugins/canva/disconnect', { token: null })).status).toBe(401);
    expect((await h.req('POST', '/plugins/canva/callback?state=x', { token: null })).status).toBe(401);
    expect((await h.req('GET', '/plugins/canva/callback/otra', { token: null })).status).toBe(401);
    expect((await h.req('GET', '/health', { token: null })).status).toBe(401);
    // Host ajeno sigue bloqueado también en el callback.
    expect((await h.req('GET', '/plugins/canva/callback?state=x', { token: null, host: 'evil.example:47811' })).status).toBe(403);
  });

  it('refresca antes de que caduque (y rota el refresh token)', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    await h.req('GET', await h.oauth.authorize(plugin.authUrl ?? ''), { token: null });
    const [firstAccess, firstRefresh] = h.oauth.issued;
    // A 40 minutos de vencer: todavía no.
    h.clock.advance(20 * 60_000);
    expect((await h.service.mcpServersFor('claude-main', 'claude-sdk')).canva).toMatchObject({ headers: { Authorization: `Bearer ${firstAccess ?? ''}` } });
    expect(h.oauth.log.filter((l) => l.body.grant_type === 'refresh_token')).toHaveLength(0);
    // A 25 minutos (margen 30 min): se refresca al entregar.
    h.clock.advance(15 * 60_000);
    const servers = await h.service.mcpServersFor('claude-main', 'claude-sdk');
    const refreshReq = h.oauth.log.filter((l) => l.body.grant_type === 'refresh_token');
    expect(refreshReq).toHaveLength(1);
    expect(refreshReq[0]?.body).toMatchObject({ refresh_token: firstRefresh, resource: h.oauth.mcpUrl });
    const [, , newAccess, newRefresh] = h.oauth.issued;
    expect(servers.canva).toMatchObject({ headers: { Authorization: `Bearer ${newAccess ?? ''}` } });
    const stored = JSON.parse((await h.vault.get(CANVA_VAULT_REF)) ?? '{}') as { tokens: { refreshToken: string } };
    expect(stored.tokens.refreshToken).toBe(newRefresh);
    // Varias entregas a la vez: un solo refresco en vuelo.
    h.clock.advance(40 * 60_000);
    await Promise.all([h.service.mcpServersFor('a1', 'claude-sdk'), h.service.mcpServersFor('a2', 'codex-cli')]);
    expect(h.oauth.log.filter((l) => l.body.grant_type === 'refresh_token')).toHaveLength(2);
  });

  it('refresco rechazado (invalid_grant): se borra la sesión y queda en error', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    await h.req('GET', await h.oauth.authorize(plugin.authUrl ?? ''), { token: null });
    h.oauth.rejectRefresh();
    h.clock.advance(50 * 60_000);
    const grant = await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 't1' });
    expect(grant.servers).toEqual({});
    expect(grant.notes.join('\n')).toContain('Canva no está disponible');
    expect(h.service.status('canva')).toMatchObject({ status: 'error' });
    expect(h.service.status('canva').detail).toContain('vuelve a conectar');
    expect(await h.vault.get(CANVA_VAULT_REF)).toBeUndefined();
  });

  it('refresco rechazado (invalid_grant) con el token ya vencido: sigue quedando en error', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    await h.req('GET', await h.oauth.authorize(plugin.authUrl ?? ''), { token: null });
    h.oauth.rejectRefresh();
    h.clock.advance(61 * 60_000);
    const grant = await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 't1' });
    expect(grant.servers).toEqual({});
    expect(h.service.status('canva')).toMatchObject({ status: 'error' });
    expect(await h.vault.get(CANVA_VAULT_REF)).toBeUndefined();
  });

  it('disconnect revoca y borra los secretos', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    await h.req('GET', await h.oauth.authorize(plugin.authUrl ?? ''), { token: null });
    const [access, refresh] = h.oauth.issued;
    const res = await h.req('POST', '/plugins/canva/disconnect');
    expect(res.status).toBe(200);
    expect((res.json as { plugin: Plugin }).plugin).toMatchObject({ status: 'disconnected', detail: 'Desconectado: token revocado y borrado de la bóveda.' });
    expect(h.oauth.revoked).toEqual([refresh, access]);
    expect(await h.vault.get(CANVA_VAULT_REF)).toBeUndefined();
    expect(await h.service.mcpServersFor('claude-main', 'claude-sdk')).toEqual({});
  });

  it('los tokens no aparecen en SQLite, en las respuestas, en los eventos ni en los registros', async () => {
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    await h.req('GET', await h.oauth.authorize(plugin.authUrl ?? ''), { token: null });
    h.clock.advance(50 * 60_000);
    await h.service.mcpServersFor('claude-main', 'claude-sdk'); // fuerza un refresco
    h.oauth.rejectRefresh();
    h.clock.advance(50 * 60_000);
    await h.service.mcpServersFor('claude-main', 'claude-sdk'); // refresco rechazado (el servidor repite el token en su error)
    const secrets = h.oauth.issued;
    expect(secrets.length).toBe(4);
    const responses = [(await h.req('GET', '/plugins')).text, (await h.req('POST', '/plugins/canva/disconnect')).text];
    const haystacks = { sqlite: dumpDatabase(h.store), responses: responses.join('\n'), events: JSON.stringify(h.messages), logs: h.logs.join('\n') };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const s of secrets) expect(text.includes(s), `${where} contiene un token`).toBe(false);
    }
    expect(haystacks.sqlite).toContain('plugins_state');
    expect(h.messages.filter((m) => m.type === 'plugin').length).toBeGreaterThan(3);
  });
});

describe('Canva: fallos pasajeros al renovar (servidor falso)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fallo de red al renovar con el token vencido: no queda en error y se recupera solo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const net = { offline: false };
    const h = await canvaHarness({}, flakyRefreshFetch(net));
    const plugin = await connectCanva(h);
    await h.req('GET', await h.oauth.authorize(plugin.authUrl ?? ''), { token: null });

    net.offline = true;
    h.clock.advance(61 * 60_000); // el token de 3600 s ya venció
    const grant = await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 't1' });
    expect(grant.servers.canva).toBeUndefined();
    expect(grant.notes.join('\n')).toContain('Canva no está disponible');
    expect(h.service.status('canva').status).toBe('connected');
    expect(h.service.status('canva').detail).toContain('se reintenta solo');

    net.offline = false;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.waitFor(() => expect(h.oauth.issued).toHaveLength(4));
    const newAccess = h.oauth.issued[2];
    await vi.waitFor(async () => expect(await storedAccessToken(h)).toBe(newAccess));
    expect(h.service.status('canva').status).toBe('connected');
    expect(h.service.status('canva').detail).toContain('Cuenta de Canva conectada por OAuth');
    const last = h.messages.filter((m) => m.type === 'plugin' && m.plugin.id === 'canva').at(-1);
    expect(last).toMatchObject({ type: 'plugin', plugin: { id: 'canva', status: 'connected' } });
    const again = await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 't2' });
    expect(again.servers.canva).toMatchObject({ headers: { Authorization: `Bearer ${newAccess ?? ''}` } });
  });

  it('una renovación correcta saca del error guardado si la bóveda tiene sesión', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await canvaHarness();
    const plugin = await connectCanva(h);
    await h.req('GET', await h.oauth.authorize(plugin.authUrl ?? ''), { token: null });
    const states = new PluginStateStore(h.store.database);
    const current = states.get('canva');
    if (!current) throw new Error('falta el estado de Canva');
    states.put({ ...current, status: 'error', detail: 'No hay una sesión de Canva vigente: vuelve a conectar.' });
    expect(h.service.status('canva').status).toBe('error');

    // El temporizador renueva a 30 minutos de vencer (token de 60 min, margen 30 min).
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.waitFor(() => expect(h.oauth.issued).toHaveLength(4));
    await vi.waitFor(() => expect(h.service.status('canva').status).toBe('connected'));
    expect(h.service.status('canva')).toMatchObject({ steps: [] });
  });
});
