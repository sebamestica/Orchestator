import { describe, expect, it } from 'vitest';
import { ApiChatAdapter, type ApiProvider } from '../../../../src/core/adapters/api/index.ts';
import type { AgentEvent, Usage } from '../../../../src/shared/index.ts';
import {
  FakeServer,
  KEY,
  collect,
  fixture,
  jsonResponse,
  makeConfig,
  makeCtx,
  ofType,
  sseResponse,
  task,
  textOf,
  type FakeRequest,
} from './helpers.ts';

/** Una ejecución completa por proveedor con la transmisión simulada de `fixtures/api/<proveedor>/`. */
interface RunCase {
  provider: ApiProvider;
  model: string;
  baseUrl?: string;
  /** Sin clave (servidor compatible local). */
  noKey?: boolean;
  url: string;
  stream: string;
  text: string;
  thinking?: string;
  usage: Usage;
  checkRequest: (req: FakeRequest) => void;
}

const cases: RunCase[] = [
  {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    url: 'https://api.anthropic.com/v1/messages',
    stream: fixture('anthropic/messages-stream.sse'),
    text: 'Hola desde Claude.',
    usage: { inputTokens: 440, outputTokens: 7, cachedInputTokens: 128, reasoningTokens: 3, model: 'claude-opus-5-5' },
    checkRequest: (req) => {
      expect(req.headers.get('x-api-key')).toBe(KEY);
      expect(req.headers.get('authorization')).toBeNull();
      expect(req.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16_000, stream: true });
      const body = req.body as { messages: { role: string; content: string }[] };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.role).toBe('user');
      expect(body.messages[0]?.content).toContain('Responde exactamente: OK');
      expect(body.messages[0]?.content).toContain('# Tarea t-api-chat');
    },
  },
  {
    provider: 'openai',
    model: 'gpt-5.5',
    url: 'https://api.openai.com/v1/responses',
    stream: fixture('openai/responses-stream.sse'),
    text: 'Hola desde OpenAI.',
    usage: { inputTokens: 295, outputTokens: 42, cachedInputTokens: 64, reasoningTokens: 30, model: 'gpt-5.5-2026-10-01' },
    checkRequest: (req) => {
      expect(req.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(req.body).toMatchObject({ model: 'gpt-5.5', stream: true, store: false });
      expect(JSON.stringify(req.body)).toContain('Responde exactamente: OK');
    },
  },
  {
    provider: 'google',
    model: 'gemini-3.5-flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse',
    stream: fixture('google/stream.sse'),
    text: 'Hola desde Gemini.',
    usage: { inputTokens: 280, outputTokens: 50, cachedInputTokens: 100, reasoningTokens: 44, model: 'gemini-3.5-flash' },
    checkRequest: (req) => {
      expect(req.headers.get('x-goog-api-key')).toBe(KEY);
      expect(req.url).not.toContain(KEY);
      expect(JSON.stringify(req.body)).toContain('Responde exactamente: OK');
    },
  },
  {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5.5',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    stream: fixture('openrouter/chat-stream.sse'),
    text: 'Hola desde OpenRouter.',
    usage: { inputTokens: 300, outputTokens: 9, cachedInputTokens: 0, reasoningTokens: 0, model: 'anthropic/claude-sonnet-5.5' },
    checkRequest: (req) => {
      expect(req.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(req.body).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', stream: true, stream_options: { include_usage: true } });
    },
  },
  {
    provider: 'openai-compatible',
    model: 'qwen3:8b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    noKey: true,
    url: 'http://127.0.0.1:11434/v1/chat/completions',
    stream: fixture('openai-compatible/chat-stream.sse'),
    text: 'Hola desde un servidor compatible.',
    thinking: 'Pienso brevemente.',
    usage: { inputTokens: 290, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 5, model: 'qwen3:8b' },
    checkRequest: (req) => {
      expect(req.headers.get('authorization')).toBeNull();
      expect(req.body).toMatchObject({ model: 'qwen3:8b', stream: true, stream_options: { include_usage: true } });
    },
  },
];

describe('ApiChatAdapter.run con respuestas simuladas', () => {
  for (const c of cases) {
    it(`${c.provider}: transmite texto, uso y done`, async () => {
      const server = new FakeServer([{ method: 'POST', url: c.url, respond: () => sseResponse(c.stream) }]);
      const adapter = new ApiChatAdapter({
        config: makeConfig(c.provider, { model: c.model, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) }),
        fetch: server.fetch,
        now: () => new Date('2026-11-01T12:00:00Z'),
        newSessionId: () => `sesion-${c.provider}`,
      });
      const events = await collect(adapter.run(task, makeCtx(c.noKey ? { env: {} } : {})));

      expect(events[0]).toMatchObject({ type: 'status', payload: { state: 'starting' } });
      expect(events[1]).toMatchObject({ type: 'status', payload: { state: 'running' } });
      expect(events.at(-2)?.type).toBe('usage');
      expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true, summary: c.text } });
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
      expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set([`sesion-${c.provider}`]));
      expect(events.every((e) => e.agentId === `api-${c.provider}` && e.ts === '2026-11-01T12:00:00.000Z')).toBe(true);
      expect(ofType(events, 'error')).toEqual([]);

      expect(textOf(events)).toBe(c.text);
      expect(ofType(events, 'text').length).toBeGreaterThan(1); // llega en fragmentos, no al final
      if (c.thinking) expect(textOf(events, 'thinking-summary')).toBe(c.thinking);
      expect(ofType(events, 'usage')[0]?.payload).toEqual(c.usage);

      expect(server.calls).toHaveLength(1);
      const [request] = server.calls;
      expect(request?.url).toBe(c.url);
      c.checkRequest(request as FakeRequest);
    });
  }

  it('la clave de ctx.env tiene prioridad sobre la inyectada y acepta el nombre propio del proveedor', async () => {
    const server = new FakeServer([
      { method: 'POST', url: 'https://api.anthropic.com/v1/messages', respond: () => sseResponse(fixture('anthropic/messages-stream.sse')) },
    ]);
    const adapter = new ApiChatAdapter({ config: makeConfig('anthropic'), fetch: server.fetch, getApiKey: () => 'clave-de-la-boveda-123' });
    await collect(adapter.run(task, makeCtx({ env: { ANTHROPIC_API_KEY: KEY } })));
    await collect(adapter.run(task, makeCtx({ env: {} })));
    expect(server.calls.map((c) => c.headers.get('x-api-key'))).toEqual([KEY, 'clave-de-la-boveda-123']);
    // Sin config.model se usa el modelo por defecto de Anthropic.
    expect(server.calls[0]?.body).toMatchObject({ model: 'claude-opus-5-5' });
  });

  it('respeta config.baseUrl, maxOutputTokens y suma el costo estimado', async () => {
    const server = new FakeServer([
      { method: 'POST', url: 'https://proxy.ejemplo.cl/v1/messages', respond: () => sseResponse(fixture('anthropic/messages-stream.sse')) },
    ]);
    const adapter = new ApiChatAdapter({
      config: makeConfig('anthropic', { baseUrl: 'https://proxy.ejemplo.cl/', model: 'claude-haiku-5-5' }),
      fetch: server.fetch,
      maxOutputTokens: 256,
      estimateCostUsd: (usage) => usage.inputTokens * 1e-6 + usage.outputTokens * 5e-6,
    });
    const events = await collect(adapter.run(task, makeCtx()));
    expect(server.calls[0]?.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 256 });
    expect(ofType(events, 'usage')[0]?.payload.costUsd).toBeCloseTo(440e-6 + 7 * 5e-6, 9);
  });

  it('avisa de conexión sin cifrar en el estado inicial y marca respuestas truncadas o bloqueadas', async () => {
    const truncated = fixture('anthropic/messages-stream.sse').replace('"stop_reason":"end_turn"', '"stop_reason":"max_tokens"');
    const refused = fixture('anthropic/messages-stream.sse').replace('"stop_reason":"end_turn"', '"stop_reason":"refusal"');
    let body = truncated;
    const server = new FakeServer([{ method: 'POST', url: 'http://10.0.0.5:8080/v1/messages', respond: () => sseResponse(body) }]);
    const adapter = new ApiChatAdapter({ config: makeConfig('anthropic', { baseUrl: 'http://10.0.0.5:8080' }), fetch: server.fetch });

    const first = await collect(adapter.run(task, makeCtx()));
    expect(first[0]).toMatchObject({ type: 'status', payload: { state: 'starting' } });
    expect((first[0] as Extract<AgentEvent, { type: 'status' }>).payload.detail).toContain('Conexión sin cifrar');
    expect(first.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
    expect((first.at(-1) as Extract<AgentEvent, { type: 'done' }>).payload.summary).toContain('truncada');

    body = refused;
    const second = await collect(adapter.run(task, makeCtx()));
    expect(second.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
    expect((second.at(-1) as Extract<AgentEvent, { type: 'done' }>).payload.summary).toContain('refusal');
  });

  it('rechaza configuraciones que no son de API', () => {
    expect(() => new ApiChatAdapter({ config: makeConfig('anthropic', { kind: 'claude-sdk' }) })).toThrow(/kind 'api'/);
    expect(() => new ApiChatAdapter({ config: makeConfig('codex') })).toThrow(/no admitido/);
  });

  it('falla con mensaje claro si falta el modelo o la URL base', async () => {
    const server = new FakeServer([{ method: 'GET', url: /.*/, respond: () => jsonResponse({}) }]);
    const noModel = await collect(new ApiChatAdapter({ config: makeConfig('openai'), fetch: server.fetch }).run(task, makeCtx()));
    expect(noModel.slice(-2)).toMatchObject([
      { type: 'error', payload: { code: 'unknown' } },
      { type: 'done', payload: { ok: false } },
    ]);
    expect(JSON.stringify(noModel)).toContain('config.model');

    const noBase = await collect(
      new ApiChatAdapter({ config: makeConfig('openai-compatible', { model: 'x' }), fetch: server.fetch }).run(task, makeCtx()),
    );
    expect(JSON.stringify(noBase)).toContain('baseUrl');
    expect(server.calls).toHaveLength(0);
  });
});


describe('ApiChatAdapter.run con la transmisión real grabada del proxy de Anthropic', () => {
  // Grabada por tests/live/api.live.test.ts (ORQ_RECORD=1) el 2026-11-01 contra el proxy http del usuario.
  const base = 'http://203.0.113.7:18082';
  const realHeaders = JSON.parse(fixture('anthropic/messages-stream.real.headers.json')) as Record<string, string>;

  it('reconstruye texto y uso finales (el uso de message_delta reemplaza al de message_start)', async () => {
    const server = new FakeServer([
      { method: 'POST', url: `${base}/v1/messages`, respond: () => sseResponse(fixture('anthropic/messages-stream.real.sse'), realHeaders) },
    ]);
    const adapter = new ApiChatAdapter({ config: makeConfig('anthropic', { baseUrl: base }), fetch: server.fetch, maxOutputTokens: 256 });
    const events = await collect(adapter.run(task, makeCtx()));

    const text = textOf(events);
    expect(text.startsWith('OK\n\n**Informe**')).toBe(true);
    expect(text.endsWith('no hace falta.')).toBe(true);
    expect(ofType(events, 'text').length).toBeGreaterThan(40);
    // 4 sin caché + 3577 leídos + 365 escritos en caché (el proxy agrega su propio prompt de sistema).
    expect(ofType(events, 'usage')[0]?.payload).toEqual({ inputTokens: 3946, outputTokens: 324, cachedInputTokens: 3577, model: 'claude-opus-5-5' });
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
    expect((events.at(-1) as Extract<AgentEvent, { type: 'done' }>).payload.summary?.startsWith('OK')).toBe(true);
    // El proxy no envía cabeceras de límite: el cupo sigue siendo presupuesto manual.
    expect(adapter.quotaMethod).toBe('manual-budget');
  });
});
