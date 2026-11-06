import { describe, expect, it } from 'vitest';
import { ApiChatAdapter } from '../../../../src/core/adapters/api/index.ts';
import { defaultApiAdapter } from '../../../../src/core/app/defaults.ts';
import { ResponseHeadersQuota } from '../../../../src/core/quota/response-headers.ts';
import { probeResultSchema } from '../../../../src/shared/index.ts';
import {
  ANTHROPIC_LIMIT_HEADERS,
  FakeServer,
  KEY,
  OPENAI_LIMIT_HEADERS,
  collect,
  fixture,
  jsonResponse,
  makeConfig,
  makeCtx,
  sseResponse,
  task,
} from './helpers.ts';

const json = (path: string) => fixture(path);

describe('ApiChatAdapter.probe con respuestas simuladas', () => {
  it('anthropic: lista los modelos reales del proxy, avisa de http:// y cae en presupuesto manual', async () => {
    const base = 'http://203.0.113.7:18082';
    const server = new FakeServer([{ url: `${base}/v1/models`, respond: () => jsonResponse(json('anthropic/models.real.json')) }]);
    const adapter = new ApiChatAdapter({
      config: makeConfig('anthropic', { baseUrl: base, model: 'claude-opus-5-5' }),
      fetch: server.fetch,
      getApiKey: () => KEY,
      estimateCostUsd: () => 0,
    });
    const probe = probeResultSchema.parse(await adapter.probe());

    expect(probe).toMatchObject({ agentId: 'api-anthropic', installed: true, authenticated: true, quotaMethod: 'manual-budget' });
    expect(probe.models).toHaveLength(40);
    expect(probe.models).toContain('claude-opus-5-5');
    expect(probe.warnings.some((w) => w.includes('Conexión sin cifrar') && w.includes(base))).toBe(true);
    expect(probe.warnings.some((w) => w.includes('presupuesto manual'))).toBe(true);
    expect(probe.warnings.some((w) => w.includes('no aparece'))).toBe(false);

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe(`${base}/v1/models?limit=1000`);
    expect(server.calls[0]?.headers.get('x-api-key')).toBe(KEY);
    expect(server.calls[0]?.headers.get('anthropic-version')).toBeTruthy();
  });

  it('openai: detecta el cupo por cabeceras de límite y usa Bearer', async () => {
    const server = new FakeServer([
      { url: 'https://api.openai.com/v1/models', respond: () => jsonResponse(json('openai/models.json'), 200, OPENAI_LIMIT_HEADERS) },
    ]);
    const adapter = new ApiChatAdapter({ config: makeConfig('openai', { model: 'gpt-5.5' }), fetch: server.fetch, getApiKey: () => KEY });
    const probe = await adapter.probe();

    expect(probe).toMatchObject({ authenticated: true, quotaMethod: 'response-headers' });
    expect(probe.models).toEqual(['gpt-5.5', 'gpt-5.5-mini', 'text-embedding-3-large']);
    expect(probe.warnings).toEqual([]);
    expect(server.calls[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('google: pagina, filtra los modelos sin generateContent y envía la clave por cabecera', async () => {
    const base = 'https://generativelanguage.googleapis.com/v1beta/models';
    const server = new FakeServer([
      { url: `${base}?pageSize=1000`, respond: () => jsonResponse(json('google/models-page1.json')) },
      { url: `${base}?pageSize=1000&pageToken=pagina-2`, respond: () => jsonResponse(json('google/models-page2.json')) },
    ]);
    const adapter = new ApiChatAdapter({
      config: makeConfig('google', { model: 'gemini-3.5-flash', budgetUsd: 5 }),
      fetch: server.fetch,
      getApiKey: async () => KEY,
    });
    const probe = await adapter.probe();

    // Sin precio conocido el presupuesto no se descuenta: se dice, en vez de dar por bueno un tope que no topa.
    expect(probe).toMatchObject({ authenticated: true, quotaMethod: 'manual-budget' });
    expect(probe.warnings).toEqual([expect.stringMatching(/no conoce el precio.*Google.*no se descuenta/)]);
    expect(probe.models).toEqual(['gemini-3.5-flash', 'gemini-3.1-pro']);
    expect(server.calls).toHaveLength(2);
    for (const call of server.calls) {
      expect(call.headers.get('x-goog-api-key')).toBe(KEY);
      expect(call.url).not.toContain(KEY);
    }
  });

  it('presupuesto manual: solo se pide budgetUsd a los proveedores cuyo costo Berland estima (agy-20)', async () => {
    const server = new FakeServer([
      { url: 'https://api.openai.com/v1/models', respond: () => jsonResponse(json('openai/models.json')) },
      { url: 'https://api.anthropic.com/v1/models', respond: () => jsonResponse(json('anthropic/models.real.json')) },
    ]);
    const factory = defaultApiAdapter(server.fetch);
    const openai = await factory(makeConfig('openai', { model: 'gpt-5.5' }), { apiKey: KEY }).probe();
    expect(openai).toMatchObject({ authenticated: true, quotaMethod: 'manual-budget', warnings: [] });
    const anthropic = await factory(makeConfig('anthropic', { model: 'claude-opus-5-5' }), { apiKey: KEY }).probe();
    expect(anthropic.warnings).toEqual([expect.stringMatching(/presupuesto manual.*Ajustes › Agentes/)]);
    const budgeted = await factory(makeConfig('anthropic', { model: 'claude-opus-5-5', budgetUsd: 3 }), { apiKey: KEY }).probe();
    expect(budgeted.warnings).toEqual([]);
  });

  it('openrouter: método openrouter-key y la clave se valida con /key (el listado es público)', async () => {
    let keyStatus = 200;
    const server = new FakeServer([
      { url: 'https://openrouter.ai/api/v1/models', respond: () => jsonResponse(json('openrouter/models.json')) },
      {
        url: 'https://openrouter.ai/api/v1/key',
        respond: () => (keyStatus === 200 ? jsonResponse(json('openrouter/key.json')) : jsonResponse(json('openrouter/error-401.json'), keyStatus)),
      },
    ]);
    const adapter = new ApiChatAdapter({ config: makeConfig('openrouter'), fetch: server.fetch, getApiKey: () => KEY });

    const ok = await adapter.probe();
    expect(ok).toMatchObject({ authenticated: true, quotaMethod: 'openrouter-key', warnings: [] });
    expect(ok.models).toEqual(['anthropic/claude-sonnet-5.5', 'openai/gpt-5.5', 'google/gemini-3.5-flash']);
    expect(server.callsTo('https://openrouter.ai/api/v1/key')[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);

    keyStatus = 401;
    const rejected = await adapter.probe();
    expect(rejected).toMatchObject({ authenticated: false, quotaMethod: 'openrouter-key' });
    expect(rejected.models).toHaveLength(3);
    expect(rejected.warnings).toEqual(['El proveedor rechazó la clave (HTTP 401).']);
  });

  it('openai-compatible: servidor local sin clave, con aviso de http://', async () => {
    const base = 'http://127.0.0.1:11434/v1';
    const server = new FakeServer([{ url: `${base}/models`, respond: () => jsonResponse(json('openai-compatible/models.json')) }]);
    const adapter = new ApiChatAdapter({ config: makeConfig('openai-compatible', { baseUrl: base, budgetUsd: 1 }), fetch: server.fetch });
    const probe = await adapter.probe();

    expect(probe).toMatchObject({ authenticated: true, quotaMethod: 'manual-budget', models: ['qwen3:8b', 'llama3.3:70b'] });
    expect(probe.warnings).toHaveLength(2);
    expect(probe.warnings[0]).toContain('Conexión sin cifrar');
    expect(probe.warnings[1]).toMatch(/no conoce el precio.*no se descuenta/);
    expect(server.calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('sin clave no llama al proveedor; con clave rechazada no la muestra en las advertencias', async () => {
    const server = new FakeServer([
      {
        url: 'https://api.anthropic.com/v1/models',
        // Un proxy mal hecho que repite la clave en el error.
        respond: (req) => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: `clave ${req.headers.get('x-api-key')} inválida` } }, 401),
      },
    ]);
    const missing = await new ApiChatAdapter({ config: makeConfig('anthropic'), fetch: server.fetch }).probe();
    expect(missing).toMatchObject({ authenticated: false, models: [] });
    expect(missing.warnings[0]).toContain('Falta la clave');
    expect(server.calls).toHaveLength(0);

    const rejected = await new ApiChatAdapter({ config: makeConfig('anthropic'), fetch: server.fetch, getApiKey: () => KEY }).probe();
    expect(rejected).toMatchObject({ authenticated: false, models: [] });
    expect(rejected.warnings).toContain('El proveedor rechazó la clave (HTTP 401).');
    expect(JSON.stringify(rejected)).not.toContain(KEY);
  });

  it('google: una clave inválida (400 API_KEY_INVALID) cuenta como no autenticada', async () => {
    const server = new FakeServer([{ url: /models\?pageSize/, respond: () => jsonResponse(json('google/error-key-invalid.json'), 400) }]);
    const probe = await new ApiChatAdapter({ config: makeConfig('google'), fetch: server.fetch, getApiKey: () => KEY }).probe();
    expect(probe.authenticated).toBe(false);
    expect(probe.warnings).toContain('El proveedor rechazó la clave (HTTP 400).');
  });

  it('avisa si el modelo configurado no está en la lista y si el proveedor no responde', async () => {
    const server = new FakeServer([{ url: 'https://api.openai.com/v1/models', respond: () => jsonResponse(json('openai/models.json')) }]);
    const probe = await new ApiChatAdapter({ config: makeConfig('openai', { model: 'gpt-9' }), fetch: server.fetch, getApiKey: () => KEY }).probe();
    expect(probe.warnings).toContain('El modelo configurado (gpt-9) no aparece en la lista del proveedor.');

    const down = new FakeServer([{ url: 'https://api.openai.com/v1/models', respond: () => jsonResponse({ error: { message: 'mantención' } }, 503) }]);
    const failed = await new ApiChatAdapter({ config: makeConfig('openai'), fetch: down.fetch, getApiKey: () => KEY, maxRetries: 0 }).probe();
    expect(failed.authenticated).toBe(false);
    expect(failed.warnings.some((w) => w.startsWith('No se pudieron listar los modelos: HTTP 503'))).toBe(true);

    const garbage = new FakeServer([{ url: 'https://api.openai.com/v1/models', respond: () => jsonResponse({ modelos: 'todos' }) }]);
    const invalid = await new ApiChatAdapter({ config: makeConfig('openai'), fetch: garbage.fetch, getApiKey: () => KEY }).probe();
    expect(invalid.warnings.some((w) => w.includes('formato inesperado'))).toBe(true);
  });

  it('pasa a response-headers cuando una ejecución trae cabeceras de límite y alimenta ResponseHeadersQuota', async () => {
    const server = new FakeServer([
      { url: 'https://api.anthropic.com/v1/models', respond: () => jsonResponse(json('anthropic/models.real.json')) },
      {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        respond: () => sseResponse(fixture('anthropic/messages-stream.sse'), ANTHROPIC_LIMIT_HEADERS),
      },
    ]);
    const now = new Date('2026-11-01T12:00:00Z');
    const quota = new ResponseHeadersQuota({ agentId: 'api-anthropic', now: () => now });
    const adapter = new ApiChatAdapter({ config: makeConfig('anthropic'), fetch: server.fetch, getApiKey: () => KEY, headersQuota: quota });

    expect((await adapter.probe()).quotaMethod).toBe('manual-budget');
    await collect(adapter.run(task, makeCtx()));
    expect(adapter.quotaMethod).toBe('response-headers');
    expect((await adapter.probe()).quotaMethod).toBe('response-headers');

    const snapshot = await quota.read();
    expect(snapshot).toMatchObject({ method: 'response-headers', stale: false });
    expect(snapshot.buckets.map((b) => [b.groupId, b.remainingFraction])).toEqual([
      ['requests', 49 / 50],
      ['tokens', 0.99],
    ]);
  });
});
