import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiChatAdapter, type FetchFn } from '../../src/core/adapters/api/index.ts';
import { agentConfigSchema, agentEventSchema, redactSecrets, taskBriefSchema, type AgentEvent } from '../../src/shared/index.ts';

/**
 * Prueba en vivo mínima del adaptador de API con el proveedor `anthropic` (gasta cupo: un encargo corto y `max_tokens` bajo).
 * Solo con ORQ_LIVE=1 y la clave en el entorno:
 *   WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/api.live.test.ts"
 * (`/w`: la variable pasa de WSL a Windows; con `/u` solo pasaría de Windows a WSL y la prueba se saltaría.)
 * Con ORQ_RECORD=1 además graba la transmisión cruda (tachada) en fixtures/api/anthropic/messages-stream.real.sse.
 * El modelo se elige con ORQ_LIVE_MODEL (por defecto el del adaptador, claude-opus-5-5).
 */

const key = process.env.ANTHROPIC_API_KEY ?? '';
const live = process.env.ORQ_LIVE === '1' && key.length > 0;
const baseUrl = process.env.ANTHROPIC_BASE_URL || undefined;
const record = process.env.ORQ_RECORD === '1';
const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/api/anthropic/', import.meta.url));

const config = agentConfigSchema.parse({
  id: 'api-anthropic-live',
  kind: 'api',
  provider: 'anthropic',
  displayName: 'Anthropic por API (prueba en vivo)',
  budgetUsd: 1,
  ...(baseUrl ? { baseUrl } : {}),
  ...(process.env.ORQ_LIVE_MODEL ? { model: process.env.ORQ_LIVE_MODEL } : {}),
});

const task = taskBriefSchema.parse({
  id: 't-api-live',
  projectId: 'orquestador',
  title: 'Prueba en vivo del adaptador de API',
  objective: 'Responde exactamente: OK',
  ownedPaths: ['tests/live/api.live.test.ts'],
  dependsOn: [],
  acceptance: ['La respuesta es exactamente OK'],
  difficulty: 'low',
});

/** `fetch` que guarda una copia de la respuesta de /v1/messages para la fixture. */
function recordingFetch(): { fetch: FetchFn; done: () => Promise<void> } {
  const pending: Promise<void>[] = [];
  const wrapped = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const res = await globalThis.fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (record && url.includes('/v1/messages')) {
      const copy = res.clone();
      pending.push(
        copy.text().then((body) => {
          const headers = Object.fromEntries([...copy.headers].filter(([name]) => !/cookie/i.test(name)));
          writeFileSync(`${FIXTURE_DIR}messages-stream.real.sse`, redactSecrets(body, [key]));
          writeFileSync(`${FIXTURE_DIR}messages-stream.real.headers.json`, `${redactSecrets(JSON.stringify(headers, null, 2), [key])}\n`);
        }),
      );
    }
    return res;
  }) as FetchFn;
  return { fetch: wrapped, done: async () => void (await Promise.all(pending)) };
}

describe.skipIf(!live)('adaptador de API en vivo (anthropic)', () => {
  it('probe: la clave funciona, lista modelos y avisa si la URL es http://', async () => {
    const probe = await new ApiChatAdapter({ config, getApiKey: () => key }).probe();
    expect(probe.authenticated).toBe(true);
    expect(probe.models.length).toBeGreaterThan(0);
    expect(['manual-budget', 'response-headers']).toContain(probe.quotaMethod);
    if (baseUrl?.startsWith('http://')) expect(probe.warnings.some((w) => w.includes('Conexión sin cifrar'))).toBe(true);
    expect(JSON.stringify(probe)).not.toContain(key);
    console.warn(`[api.live] probe: ${probe.models.length} modelos, cupo ${probe.quotaMethod}, ${probe.warnings.length} advertencias`);
  }, 60_000);

  it('run: «Responde exactamente: OK» transmite texto, uso y done', async () => {
    const recorder = recordingFetch();
    const adapter = new ApiChatAdapter({ config, fetch: recorder.fetch, maxOutputTokens: 256 });
    const events: AgentEvent[] = [];
    const ctx = { worktreePath: process.cwd(), env: { ORQ_API_KEY: key }, signal: new AbortController().signal, timeoutMs: 120_000 };
    for await (const event of adapter.run(task, ctx)) events.push(agentEventSchema.parse(event));
    await recorder.done();

    const error = events.find((e) => e.type === 'error');
    expect(error, JSON.stringify(error)).toBeUndefined();
    const text = events.map((e) => (e.type === 'text' && e.payload.role === 'assistant' ? e.payload.text : '')).join('');
    expect(text).toContain('OK');
    const usage = events.find((e) => e.type === 'usage');
    expect(usage?.type === 'usage' && usage.payload.inputTokens > 0 && usage.payload.outputTokens > 0).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
    expect(JSON.stringify(events)).not.toContain(key);
    console.warn(`[api.live] run: texto=${JSON.stringify(text)} uso=${JSON.stringify(usage?.payload)} eventos=${events.length}`);
  }, 150_000);
});
