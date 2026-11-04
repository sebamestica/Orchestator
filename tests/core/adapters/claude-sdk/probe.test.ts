import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from '../../../../src/core/adapters/claude-sdk/index.ts';
import { agentConfigSchema, probeResultSchema } from '../../../../src/shared/index.ts';
import { FAKE_KEY, config, fixturePath } from './helpers.ts';

/** Respuesta real de `GET /v1/models` del servidor intermedio del usuario (grabada el 2026-11-01; sin claves). */
const MODELS = readFileSync(fixturePath('models-list.json'), 'utf8');
const BASE = 'http://203.0.113.7';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

function mockFetch(routes: (call: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input instanceof Request ? input.url : input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    return routes(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, type: string, message: string) => json({ type: 'error', error: { type, message } }, status);

function adapter(fetch: typeof globalThis.fetch, env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: BASE }, cfg = config) {
  return new ClaudeSdkAdapter({ config: cfg, fetch, probeEnv: () => env, sdkVersion: '0.3.302' });
}

describe('ClaudeSdkAdapter.probe', () => {
  it('lista los modelos del servidor sin gastar tokens y avisa de la conexión sin cifrar', async () => {
    const { fetch, calls } = mockFetch(() => json(MODELS));
    const probe = probeResultSchema.parse(await adapter(fetch).probe());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/models?limit=100`);
    expect(calls[0]?.headers.get('x-api-key')).toBe(FAKE_KEY);
    expect(calls[0]?.headers.get('anthropic-version')).toBeTruthy();

    expect(probe).toMatchObject({ agentId: 'claude-main', installed: true, authenticated: true, version: '0.3.302', quotaMethod: 'manual-budget' });
    expect(probe.models).toHaveLength(40);
    expect(probe.models).toContain('claude-opus-5-5');
    expect(probe.warnings).toEqual([
      'La URL base 203.0.113.7 usa http://: conexión sin cifrar. La clave, los encargos y el código viajan en claro.',
      'Sin presupuesto (budgetUsd): el servidor no informa saldo y el gasto no tendrá tope.',
    ]);
  });

  it('con https y presupuesto no hay advertencias; config.baseUrl manda sobre el entorno', async () => {
    const { fetch, calls } = mockFetch(() => json(MODELS));
    const cfg = agentConfigSchema.parse({ ...config, baseUrl: 'https://api.anthropic.com', budgetUsd: 20 });
    const probe = await adapter(fetch, { ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: BASE }, cfg).probe();
    expect(calls[0]?.url.startsWith('https://api.anthropic.com/v1/models')).toBe(true);
    expect(probe.warnings).toEqual([]);
  });

  it('clave rechazada (401): authenticated false y sin la clave en el resultado', async () => {
    const { fetch } = mockFetch(() => apiError(401, 'authentication_error', `invalid x-api-key ${FAKE_KEY}`));
    const probe = probeResultSchema.parse(await adapter(fetch).probe());
    expect(probe.authenticated).toBe(false);
    expect(probe.models).toEqual([]);
    expect(probe.warnings).toContain('El servidor rechazó la clave (HTTP 401).');
    expect(JSON.stringify(probe)).not.toContain(FAKE_KEY);
  });

  it('sin saldo (402): la clave es válida pero se avisa la falta de saldo', async () => {
    const { fetch } = mockFetch(() => apiError(402, 'billing_error', 'Your credit balance is too low'));
    const probe = await adapter(fetch).probe();
    expect(probe.authenticated).toBe(true);
    expect(probe.models).toEqual([]);
    expect(probe.warnings).toContain('Sin saldo o con límite de uso (HTTP 402).');
  });

  it('si el servidor no expone /v1/models, hace una llamada mínima de 1 token', async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.url.includes('/v1/models')
        ? apiError(404, 'not_found_error', 'Not found')
        : json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'p' }], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } }),
    );
    const probe = await adapter(fetch).probe();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v1/models', 'POST /v1/messages']);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1 });
    expect(probe).toMatchObject({ authenticated: true, models: ['claude-opus-5-5'] });
  });

  it('sin clave no llama al servidor', async () => {
    const { fetch, calls } = mockFetch(() => json(MODELS));
    const probe = await adapter(fetch, { ANTHROPIC_BASE_URL: BASE }).probe();
    expect(calls).toHaveLength(0);
    expect(probe.authenticated).toBe(false);
    expect(probe.warnings).toContain('Falta ANTHROPIC_API_KEY (o ANTHROPIC_AUTH_TOKEN).');
  });

  it('avisa si el modelo configurado no está en la lista', async () => {
    const { fetch } = mockFetch(() => json(MODELS));
    const cfg = agentConfigSchema.parse({ ...config, model: 'claude-inexistente-9' });
    const probe = await adapter(fetch, undefined, cfg).probe();
    expect(probe.warnings).toContain('El modelo claude-inexistente-9 no aparece en la lista del servidor.');
  });

  it('error de red: authenticated false con el motivo', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const probe = await adapter(fetch).probe();
    expect(probe.authenticated).toBe(false);
    expect(probe.warnings.some((w) => w.startsWith('No se pudo conectar con el servidor'))).toBe(true);
  });
});
