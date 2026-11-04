import { describe, expect, it } from 'vitest';
import { apiSchemas } from '../../../src/core/server/index.ts';
import { fillPath, makeTestApp } from './helpers.ts';

const PARAMS = { id: 'agente-1', project: 'proyecto-1', name: 'skill-1' };

describe('autenticación por token', () => {
  it('todas las rutas rechazan sin token, con token incorrecto o con otro esquema', async () => {
    const t = makeTestApp();
    expect(t.routes.length).toBeGreaterThanOrEqual(30);
    const wrong = `${t.token.slice(0, -2)}xx`;
    for (const spec of t.routes) {
      const path = fillPath(spec.path, PARAMS);
      const method = spec.method.toUpperCase();
      for (const auth of [{ token: null }, { token: wrong }, { token: null, headers: { authorization: `Basic ${t.token}` } }] as const) {
        const res = await t.req(method, path, { ...auth, ...(spec.body ? { body: {} } : {}) });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(apiSchemas.errorResponse.parse(res.json).error.code).toBe('unauthorized');
        expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      }
    }
  });

  it('no acepta el token en la consulta ni en cookies', async () => {
    const t = makeTestApp();
    expect((await t.req('GET', `/health?token=${t.token}`, { token: null })).status).toBe(401);
    expect((await t.req('GET', '/health', { token: null, headers: { cookie: `token=${t.token}` } })).status).toBe(401);
  });

  it('acepta el token correcto (esquema sin distinguir mayúsculas) y genera uno distinto por arranque', async () => {
    const a = makeTestApp();
    const b = makeTestApp();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await a.req('GET', '/health')).status).toBe(200);
    expect((await a.req('GET', '/health', { token: null, headers: { authorization: `bearer ${a.token}` } })).status).toBe(200);
    expect((await a.req('GET', '/health', { token: b.token })).status).toBe(401);
  });
});

describe('encabezado Host (DNS rebinding)', () => {
  it('rechaza un Host ajeno en todas las rutas aunque el token sea válido, y antes de pedir token', async () => {
    const t = makeTestApp();
    for (const spec of t.routes) {
      const path = fillPath(spec.path, PARAMS);
      for (const host of ['evil.example', 'evil.example:47811', '127.0.0.1.nip.io:47811']) {
        const res = await t.req(spec.method.toUpperCase(), path, { host });
        expect(res.status, `${spec.method} ${path} ${host}`).toBe(403);
        expect(apiSchemas.errorResponse.parse(res.json).error.code).toBe('forbidden_host');
      }
    }
    expect((await t.req('GET', '/health', { host: 'evil.example', token: null })).status).toBe(403);
  });

  it('solo acepta 127.0.0.1 y localhost con el puerto del servidor', async () => {
    const t = makeTestApp();
    expect((await t.req('GET', '/health', { host: '127.0.0.1:47811' })).status).toBe(200);
    expect((await t.req('GET', '/health', { host: 'LOCALHOST:47811' })).status).toBe(200);
    for (const host of ['127.0.0.1', '127.0.0.1:9999', 'localhost', '[::1]:47811', '0.0.0.0:47811']) {
      expect((await t.req('GET', '/health', { host })).status, host).toBe(403);
    }
  });
});

describe('sin CORS', () => {
  it('rechaza peticiones con Origin de navegador y no emite encabezados CORS', async () => {
    const t = makeTestApp();
    const res = await t.req('GET', '/agents', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(apiSchemas.errorResponse.parse(res.json).error.code).toBe('forbidden_origin');
    const pre = await t.req('OPTIONS', '/agents', {
      token: null,
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
    });
    expect(pre.status).toBe(403);
    const ok = await t.req('GET', '/health');
    for (const r of [res, pre, ok]) {
      expect([...r.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
    expect((await t.req('GET', '/health', { headers: { origin: 'null' } })).status).toBe(403);
  });

  it('permite solo los orígenes configurados', async () => {
    const t = makeTestApp({ allowedOrigins: ['app://orquestador'] });
    expect((await t.req('GET', '/health', { headers: { origin: 'app://orquestador' } })).status).toBe(200);
    expect((await t.req('GET', '/health', { headers: { origin: 'app://otro' } })).status).toBe(403);
  });

  it('agrega encabezados defensivos también a los errores', async () => {
    const t = makeTestApp();
    for (const r of [await t.req('GET', '/health'), await t.req('GET', '/health', { token: null })]) {
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});
