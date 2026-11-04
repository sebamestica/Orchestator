import { describe, expect, it } from 'vitest';
import { ApiChatAdapter, type ApiProvider } from '../../../../src/core/adapters/api/index.ts';
import type { AgentEvent, ErrorCode, RunContext } from '../../../../src/shared/index.ts';
import { REDACTED } from '../../../../src/shared/index.ts';
import {
  FakeServer,
  KEY,
  PLAIN_KEY,
  collect,
  fixture,
  hangingSse,
  jsonResponse,
  makeConfig,
  makeCtx,
  ofType,
  sseHead,
  sseResponse,
  task,
  type Responder,
} from './helpers.ts';

/** Cabecera que los dos SDK respetan para reintentar sin esperar (prueba rápida de «429 persistente»). */
const RETRY_NOW = { 'retry-after-ms': '1' };

interface Target {
  url: string;
  model: string;
  baseUrl?: string;
  stream: string;
}

const TARGETS: Record<ApiProvider, Target> = {
  anthropic: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-opus-5-5', stream: fixture('anthropic/messages-stream.sse') },
  openai: { url: 'https://api.openai.com/v1/responses', model: 'gpt-5.5', stream: fixture('openai/responses-stream.sse') },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse',
    model: 'gemini-3.5-flash',
    stream: fixture('google/stream.sse'),
  },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-5.5', stream: fixture('openrouter/chat-stream.sse') },
  'openai-compatible': {
    url: 'https://llm.ejemplo.cl/v1/chat/completions',
    model: 'qwen3:8b',
    baseUrl: 'https://llm.ejemplo.cl/v1',
    stream: fixture('openai-compatible/chat-stream.sse'),
  },
};

const PROVIDERS = Object.keys(TARGETS) as ApiProvider[];

function setup(provider: ApiProvider, respond: Responder, opts: { maxRetries?: number } = {}) {
  const t = TARGETS[provider];
  const server = new FakeServer([{ method: 'POST', url: t.url, respond }]);
  const adapter = new ApiChatAdapter({
    config: makeConfig(provider, { model: t.model, ...(t.baseUrl ? { baseUrl: t.baseUrl } : {}) }),
    fetch: server.fetch,
    maxRetries: opts.maxRetries ?? 2,
  });
  return { server, adapter, target: t };
}

async function runWith(provider: ApiProvider, respond: Responder, ctx: Partial<RunContext> = {}, opts: { maxRetries?: number } = {}) {
  const { server, adapter } = setup(provider, respond, opts);
  const events = await collect(adapter.run(task, makeCtx(ctx)));
  return { server, events };
}

function failure(events: readonly AgentEvent[]): { code: ErrorCode; message: string } | undefined {
  return ofType(events, 'error')[0]?.payload;
}

function expectFailed(events: readonly AgentEvent[], code: ErrorCode): void {
  expect(events.slice(-2).map((e) => e.type)).toEqual(['error', 'done']);
  expect(failure(events)?.code).toBe(code);
  expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
  expect(ofType(events, 'usage')).toEqual([]);
}

describe('ApiChatAdapter: errores de autenticación', () => {
  const cases: [ApiProvider, number, string][] = [
    ['anthropic', 401, fixture('anthropic/error-401.json')],
    ['openai', 401, fixture('openai/error-401.json')],
    ['google', 400, fixture('google/error-key-invalid.json')],
    ['openrouter', 401, fixture('openrouter/error-401.json')],
    ['openai-compatible', 403, JSON.stringify({ error: { message: 'Forbidden', type: 'permission_error' } })],
  ];
  for (const [provider, status, body] of cases) {
    it(`${provider}: HTTP ${status} → auth, sin reintentos`, async () => {
      const { server, events } = await runWith(provider, () => jsonResponse(body, status));
      expectFailed(events, 'auth');
      expect(failure(events)?.message).toContain(`HTTP ${status}`);
      expect(server.calls).toHaveLength(1);
    });
  }

  it('sin clave en ctx.env ni función inyectada → auth sin llamar al proveedor', async () => {
    const { server, events } = await runWith('openai', () => sseResponse(TARGETS.openai.stream), { env: {} });
    expectFailed(events, 'auth');
    expect(failure(events)?.message).toContain('ORQ_API_KEY');
    expect(server.calls).toHaveLength(0);
  });
});

describe('ApiChatAdapter: cupo agotado', () => {
  for (const provider of PROVIDERS) {
    it(`${provider}: 429 que persiste tras los reintentos → quota_exhausted`, async () => {
      const body = provider === 'google' ? fixture('google/error-429.json') : provider === 'anthropic' ? fixture('anthropic/error-429.json') : JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } });
      const { server, events } = await runWith(provider, () => jsonResponse(body, 429, RETRY_NOW), {}, { maxRetries: 2 });
      expectFailed(events, 'quota_exhausted');
      expect(failure(events)?.message).toContain('HTTP 429');
      expect(server.calls).toHaveLength(3);
    });
  }

  it('un 429 pasajero se reintenta y la tarea termina bien', async () => {
    const { server, events } = await runWith('openai', (_req, attempt) =>
      attempt === 1 ? jsonResponse({ error: { message: 'slow down' } }, 429, RETRY_NOW) : sseResponse(TARGETS.openai.stream),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
    expect(server.calls).toHaveLength(2);
  });

  it('openai: insufficient_quota → quota_exhausted', async () => {
    const { events } = await runWith('openai', () => jsonResponse(fixture('openai/error-insufficient-quota.json'), 429, RETRY_NOW), {}, { maxRetries: 1 });
    expectFailed(events, 'quota_exhausted');
    expect(failure(events)?.message).toContain('tras 2 intentos');
  });

  it('openrouter: 402 sin saldo → quota_exhausted sin reintentos', async () => {
    const { server, events } = await runWith('openrouter', () => jsonResponse(fixture('openrouter/error-402.json'), 402));
    expectFailed(events, 'quota_exhausted');
    expect(server.calls).toHaveLength(1);
  });

  it('anthropic: «credit balance is too low» (HTTP 400) → quota_exhausted', async () => {
    const { events } = await runWith('anthropic', () => jsonResponse(fixture('anthropic/error-credit.json'), 400));
    expectFailed(events, 'quota_exhausted');
  });

  it('anthropic: error de límite a mitad de la transmisión → quota_exhausted', async () => {
    const stream = `${sseHead(TARGETS.anthropic.stream, 4)}event: error\ndata: ${fixture('anthropic/error-429.json').trim()}\n\n`;
    const { events } = await runWith('anthropic', () => sseResponse(stream));
    expect(ofType(events, 'text').length).toBeGreaterThan(0);
    expectFailed(events, 'quota_exhausted');
  });

  it('openrouter: error 402 a mitad de la transmisión → quota_exhausted', async () => {
    const stream = `${sseHead(TARGETS.openrouter.stream, 2)}data: ${fixture('openrouter/error-402.json').trim()}\n\n`;
    const { events } = await runWith('openrouter', () => sseResponse(stream));
    expectFailed(events, 'quota_exhausted');
  });

  it('openai: evento error con insufficient_quota a mitad de la transmisión → quota_exhausted', async () => {
    const error = { type: 'error', sequence_number: 6, code: 'insufficient_quota', message: 'You exceeded your current quota.', param: null };
    const stream = `${sseHead(TARGETS.openai.stream, 5)}event: error\ndata: ${JSON.stringify(error)}\n\n`;
    const { events } = await runWith('openai', () => sseResponse(stream));
    expectFailed(events, 'quota_exhausted');
    expect(failure(events)?.message).toContain('You exceeded your current quota.');
  });
});

describe('ApiChatAdapter: cancelación y plazo', () => {
  for (const provider of PROVIDERS) {
    it(`${provider}: abortar ctx.signal a mitad → cancelled y se corta la conexión`, async () => {
      const blocks = provider === 'openai' ? 5 : provider === 'openrouter' ? 2 : 1;
      const head = provider === 'anthropic' ? sseHead(TARGETS.anthropic.stream, 4) : sseHead(TARGETS[provider].stream, blocks);
      const { server, adapter } = setup(provider, (req) => hangingSse(head, req.signal));
      const controller = new AbortController();
      const events = await collect(adapter.run(task, makeCtx({ signal: controller.signal })), (e) => {
        if (e.type === 'text') controller.abort();
      });
      expect(ofType(events, 'text').length).toBeGreaterThan(0);
      expectFailed(events, 'cancelled');
      expect(server.calls[0]?.signal?.aborted).toBe(true);
    });

    it(`${provider}: sin respuesta antes de ctx.timeoutMs → timeout`, async () => {
      const { server, events } = await runWith(provider, (req) => hangingSse('', req.signal), { timeoutMs: 150 });
      expectFailed(events, 'timeout');
      expect(failure(events)?.message).toContain('150 ms');
      expect(server.calls[0]?.signal?.aborted).toBe(true);
    });
  }

  it('señal ya abortada → cancelled sin llamar al proveedor', async () => {
    const controller = new AbortController();
    controller.abort();
    const { server, events } = await runWith('anthropic', () => sseResponse(TARGETS.anthropic.stream), { signal: controller.signal });
    expectFailed(events, 'cancelled');
    expect(server.calls).toHaveLength(0);
  });

  it('si quien consume deja de iterar, se aborta la solicitud', async () => {
    const { server, adapter } = setup('google', (req) => hangingSse(sseHead(TARGETS.google.stream, 1), req.signal));
    for await (const event of adapter.run(task, makeCtx())) {
      if (event.type === 'text') break;
    }
    expect(server.calls[0]?.signal?.aborted).toBe(true);
  });
});

describe('ApiChatAdapter: salida inválida', () => {
  it('openrouter: fragmento que no cumple el formato → invalid_output', async () => {
    const { events } = await runWith('openrouter', () => sseResponse('data: {"choices":"no-es-lista"}\n\n'));
    expectFailed(events, 'invalid_output');
  });

  it('anthropic: transmisión vacía → error y done sin uso', async () => {
    const { events } = await runWith('anthropic', () => sseResponse(''));
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
    expect(ofType(events, 'error')).toHaveLength(1);
  });
});

describe('ApiChatAdapter: ningún evento contiene la clave', () => {
  const echoText = (req: Parameters<Responder>[0]) =>
    `${req.headers.get('x-api-key') ?? ''} ${req.headers.get('authorization') ?? ''} ${req.headers.get('x-goog-api-key') ?? ''}`.trim();

  for (const key of [KEY, PLAIN_KEY]) {
    for (const provider of PROVIDERS) {
      it(`${provider}: un error que repite la clave ${key === KEY ? 'con formato' : 'sin formato'} se tacha`, async () => {
        const { events } = await runWith(
          provider,
          (req) => jsonResponse({ error: { message: `clave rechazada: ${echoText(req)}`, type: 'authentication_error' } }, 401),
          { env: { ORQ_API_KEY: key } },
        );
        expectFailed(events, 'auth');
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain(key);
        expect(serialized).toContain(REDACTED);
      });
    }

    it(`texto del modelo que repite la clave ${key === KEY ? 'con formato' : 'sin formato'} se tacha`, async () => {
      const stream = TARGETS.anthropic.stream.replace('Hola desde ', `Tu clave es ${key} y `);
      const { events } = await runWith('anthropic', () => sseResponse(stream), { env: { ORQ_API_KEY: key, OTRA_VARIABLE: 'secreto-de-otra-variable' } });
      expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(key);
      expect(serialized).toContain(`Tu clave es ${REDACTED} y Claude.`);
    });

    it(`clave ${key === KEY ? 'con formato' : 'sin formato'} partida entre dos fragmentos de texto se tacha`, async () => {
      const half = Math.floor(key.length / 2);
      const stream = TARGETS.anthropic.stream
        .replace('"text":"Hola desde "', `"text":"Clave: ${key.slice(0, half)}"`)
        .replace('"text":"Claude."', `"text":"${key.slice(half)} fin."`);
      const { events } = await runWith('anthropic', () => sseResponse(stream), { env: { ORQ_API_KEY: key } });
      const texts = ofType(events, 'text').map((e) => e.payload.text);
      expect(texts.join('')).toBe(`Clave: ${REDACTED} fin.`);
      expect(texts.some((t) => t.includes(key.slice(0, half)) || t.includes(key.slice(half)))).toBe(false);
      expect(JSON.stringify(events)).not.toContain(key);
    });
  }
});
