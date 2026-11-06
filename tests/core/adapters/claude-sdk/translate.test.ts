import { describe, expect, it } from 'vitest';
import { ClaudeSdkTranslator, SUMMARY_MAX, describeToolInput, toolResultText, truncate } from '../../../../src/core/adapters/claude-sdk/index.ts';
import { agentEventSchema, type AgentEvent } from '../../../../src/shared/index.ts';
import { FAKE_KEY, WORKTREE, loadJsonl, payload } from './helpers.ts';

const MAIN = 'sesion-principal';
const SUB = 'toolu_bdrk_014aVHw3XNNECUrts95msFAr'; // id de la llamada Agent en la fixture real

function translator() {
  return new ClaudeSdkTranslator({ agentId: 'claude-main', sessionId: MAIN, now: () => new Date('2026-11-01T12:00:00.000Z'), secrets: [FAKE_KEY], cwd: WORKTREE });
}

function translateAll(messages: readonly unknown[], tr = translator()): AgentEvent[] {
  return messages.flatMap((m) => tr.translate(m)).map((e) => agentEventSchema.parse(e));
}

describe('ClaudeSdkTranslator con la fixture real (tarea con un subagente)', () => {
  const messages = loadJsonl('subagent-run.jsonl');

  it('la fixture contiene mensajes de subagente con parent_tool_use_id', () => {
    const sub = messages.filter((m) => (m as { parent_tool_use_id?: string | null }).parent_tool_use_id === SUB);
    expect(sub.length).toBeGreaterThanOrEqual(2);
  });

  it('traduce todo sin eventos raw, con seq consecutivo y done al final', () => {
    const events = translateAll(messages);
    expect(events.filter((e) => e.type === 'raw')).toEqual([]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.agentId === 'claude-main' && e.ts === '2026-11-01T12:00:00.000Z')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: MAIN, payload: { ok: true, summary: 'OK ARANDANO' } });
    expect(events.map((e) => `${e.type}@${e.sessionId === MAIN ? 'main' : 'sub'}`)).toEqual([
      'status@main', // init
      'tool_call@main', // Agent
      'status@sub', // task_started
      'text@sub', // SUB-OK
      'status@sub', // task_updated completed
      'status@sub', // task_notification completed
      'tool_result@main', // informe del subagente
      'text@main', // OK ARANDANO
      'usage@main',
      'done@main',
    ]);
  });

  it('arma el árbol: el subagente cuelga de la sesión principal', () => {
    const events = translateAll(messages);
    const sub = events.filter((e) => e.sessionId === SUB);
    expect(sub.length).toBe(4);
    expect(sub.every((e) => e.parentSessionId === MAIN)).toBe(true);
    expect(events.filter((e) => e.sessionId === MAIN).every((e) => e.parentSessionId === undefined)).toBe(true);

    const [started, updated, notified] = sub.filter((e) => e.type === 'status').map((e) => e.payload);
    expect(started).toEqual({ state: 'running', detail: 'general-purpose: Minimal subagent test' });
    expect(updated).toEqual({ state: 'done', detail: 'completed' });
    expect(notified).toEqual({ state: 'done', detail: 'SUB-OK · 33064 tokens, 0 herramientas, 5 s' });
    expect(sub.find((e) => e.type === 'text')?.payload).toEqual({ text: 'SUB-OK', role: 'assistant' });
  });

  it('la llamada Agent y su resultado usan el mismo callId; el resumen es el informe limpio', () => {
    const events = translateAll(messages);
    expect(payload(events, 'tool_call')).toEqual([{ callId: SUB, name: 'Agent', inputSummary: 'general-purpose: Minimal subagent test' }]);
    expect(payload(events, 'tool_result')).toEqual([{ callId: SUB, ok: true, summary: 'SUB-OK' }]);
  });

  it('informa estado inicial, uso por modelo con costo y guarda el session_id del SDK', () => {
    const tr = translator();
    const events = translateAll(messages, tr);
    expect(events[0]?.payload).toEqual({ state: 'running', detail: 'modelo claude-opus-5-5 · Claude Code 2.1.302 · permisos acceptEdits' });
    expect(payload(events, 'usage')).toEqual([
      { inputTokens: 16 + 46330 + 77719, outputTokens: 196, cachedInputTokens: 46330, cacheWriteTokens: 77719, reasoningTokens: 0, costUsd: 0.401845, model: 'claude-opus-5-5' },
    ]);
    expect(tr.sdkSessionId).toBe('d21b3f48-2a67-4f10-b0dd-ec6b5b6ba138');
    expect(tr.costUsd).toBe(0.401845);
    expect(tr.finished).toBe(true);
  });

  it('estima el costo en curso con el usage de cada mensaje (antes del resultado)', () => {
    const tr = translator();
    translateAll(messages.slice(0, 2), tr); // init + primer mensaje del asistente
    // El servidor intermedio adelanta 31486 de entrada sin repartir la caché: ×1,4 = 44080, primera llamada del hilo →
    // todo se escribe en caché (5 USD/M en Opus 5.5). Salida: 48 tokens (los ~168 caracteres de la llamada Agent).
    expect(tr.estimatedCostUsd).toBeCloseTo((44080 * 5 + 48 * 20) / 1e6, 9);
    expect(tr.spentUsd).toBe(tr.estimatedCostUsd);
    const partial = tr.partialUsageEvents().map((e) => e.payload);
    expect(partial).toEqual([{ inputTokens: 44080, outputTokens: 48, cachedInputTokens: 0, cacheWriteTokens: 44080, costUsd: 0.22136, model: 'claude-opus-5-5' }]);
  });
});

describe('ClaudeSdkTranslator: costo de una sesión cortada (sesión de 14,55 USD del 2026-11-04)', () => {
  /** Traduce la fixture sin su `result`, como una sesión cancelada a medias. */
  function cut(name: string, now?: () => Date) {
    const all = loadJsonl(name);
    const tr = new ClaudeSdkTranslator({ agentId: 'claude-main', sessionId: MAIN, ...(now ? { now } : {}) });
    translateAll(all.filter((m) => (m as { type?: string }).type !== 'result'), tr);
    type ModelUsage = { inputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
    const result = all.find((m) => (m as { type?: string }).type === 'result') as { total_cost_usd: number; modelUsage: Record<string, ModelUsage> };
    return { tr, real: result };
  }

  for (const name of ['hook-deny.jsonl', 'subagent-run.jsonl']) {
    it(`${name}: la estimación queda a ±10 % del costo real (antes, «todo sin caché»)`, () => {
      const { tr, real } = cut(name);
      const ratio = tr.estimatedCostUsd / real.total_cost_usd;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
      const [usage] = payload(tr.partialUsageEvents(), 'usage');
      expect(tr.partialUsageEvents()).toHaveLength(1);
      // Entrada real de todas las llamadas (también las del subagente): la de `modelUsage`.
      const realInput = Object.values(real.modelUsage).reduce((n, u) => n + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
      expect(Math.abs((usage?.inputTokens ?? 0) / realInput - 1)).toBeLessThan(0.05);
      // Lo leído de caché ya no es 0: es el prompt de la llamada anterior de cada hilo.
      expect(usage?.cachedInputTokens).toBeGreaterThan(40_000);
    });
  }

  it('tras más de 5 min entre llamadas del mismo hilo la caché expiró: se cuenta como escritura', () => {
    let t = Date.parse('2026-11-04T18:00:00Z');
    const { tr } = cut('hook-deny.jsonl', () => new Date((t += 6 * 60_000)));
    const [usage] = payload(tr.partialUsageEvents(), 'usage');
    expect(usage?.cachedInputTokens).toBe(0);
    const warm = cut('hook-deny.jsonl').tr.estimatedCostUsd;
    expect(tr.estimatedCostUsd).toBeGreaterThan(warm);
  });

  it('un usage con la caché repartida (API directa) se cuenta tal cual', () => {
    const tr = translator();
    tr.translate({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000 } },
    });
    expect(tr.partialUsageEvents()[0]?.payload).toEqual({ inputTokens: 92_010, outputTokens: 1, cachedInputTokens: 90_000, cacheWriteTokens: 2_000, costUsd: 0.02806, model: 'claude-opus-5-5' });
  });
});

describe('ClaudeSdkTranslator con errores reales', () => {
  it('clave inválida: los reintentos 401 marcan auth como fatal y el resultado da error auth', () => {
    const tr = translator();
    const events = translateAll(loadJsonl('auth-error.jsonl'), tr);
    expect(tr.fatal).toMatchObject({ code: 'auth' });
    const waiting = payload(events, 'status').filter((p) => p.state === 'waiting');
    expect(waiting).toHaveLength(10);
    expect(waiting[0]?.detail).toBe('reintento 1/10 tras HTTP 401; espera 1 s');
    // El texto sintético «Failed to authenticate» no se muestra como respuesta del modelo.
    expect(payload(events, 'text')).toEqual([]);
    expect(payload(events, 'error')).toEqual([{ code: 'auth', message: 'Failed to authenticate. API Error: 401 unauthorized (HTTP 401)' }]);
    expect(events.at(-1)?.payload).toEqual({ ok: false, summary: 'Failed to authenticate. API Error: 401 unauthorized' });
    expect(payload(events, 'usage')).toEqual([{ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0 }]);
  });

  it('tope de presupuesto del SDK (error_max_budget_usd) → quota_exhausted con el gasto registrado', () => {
    const events = translateAll(loadJsonl('budget-exceeded.jsonl'));
    expect(payload(events, 'usage')).toEqual([
      { inputTokens: 4 + 4909, outputTokens: 33, cachedInputTokens: 0, cacheWriteTokens: 4909, reasoningTokens: 0, costUsd: 0.025221, model: 'claude-opus-5-5' },
    ]);
    expect(payload(events, 'error')).toEqual([{ code: 'quota_exhausted', message: 'Se alcanzó el tope de presupuesto del encargo (0.0252 USD gastados).' }]);
    expect(events.at(-1)?.payload).toMatchObject({ ok: false });
  });
});

/** Resultado de error mínimo con la forma de `SDKResultError`/`SDKResultSuccess`. */
function result(fields: Record<string, unknown>) {
  return { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0, usage: {}, modelUsage: {}, session_id: 's', ...fields };
}

describe('clasificación de errores del resultado', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['401 del servidor', { api_error_status: 401, result: 'API Error: 401' }, 'auth'],
    ['403 del servidor', { api_error_status: 403, result: 'Forbidden' }, 'auth'],
    ['clave inválida (texto)', { result: 'Invalid API key · Please run /login' }, 'auth'],
    ['saldo insuficiente (texto)', { result: 'Credit balance is too low' }, 'quota_exhausted'],
    ['402', { api_error_status: 402, result: 'Payment Required' }, 'quota_exhausted'],
    ['429 persistente', { subtype: 'error_during_execution', api_error_status: 429, errors: ['API Error: 429 rate_limit_error'] }, 'quota_exhausted'],
    ['tope del SDK', { subtype: 'error_max_budget_usd', errors: ['Reached maximum budget ($0.01)'] }, 'quota_exhausted'],
    ['error desconocido', { subtype: 'error_during_execution', errors: ['algo se rompió'] }, 'unknown'],
  ];
  for (const [name, fields, code] of cases) {
    it(name, () => {
      const events = translateAll([result(fields)]);
      expect(payload(events, 'error')[0]?.code).toBe(code);
      expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
    });
  }

  it('usa la pista de un mensaje previo si el resultado no dice más', () => {
    const tr = translator();
    tr.translate({ type: 'assistant', parent_tool_use_id: null, error: 'billing_error', message: { content: [] } });
    const events = tr.translate(result({ subtype: 'error_during_execution', errors: [] }));
    expect(payload(events, 'error')[0]?.code).toBe('quota_exhausted');
  });

  it('un 429 transitorio queda como pista, no como error fatal', () => {
    const tr = translator();
    const events = tr.translate({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit' });
    expect(events[0]?.payload).toMatchObject({ state: 'waiting' });
    expect(tr.hint?.code).toBe('quota_exhausted');
    expect(tr.fatal).toBeUndefined();
  });

  const retry429 = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit' };
  const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } };
  const goodReply = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'sigo' }] } };
  for (const [name, limit] of [['api_retry 429', retry429], ['rate_limit_event rejected', rejected]] as const) {
    it(`${name} resuelto: un fallo posterior de otra causa no sale como cupo agotado`, () => {
      const tr = translator();
      tr.translate(limit);
      tr.translate(goodReply);
      const events = tr.translate(result({ subtype: 'error_during_execution', errors: ['Prompt is too long'] }));
      const [error] = payload(events, 'error');
      expect(error?.code).toBe('unknown');
      expect(error?.message).toMatch(/^Prompt is too long/);
    });

    it(`${name} sin respuesta buena después: el fallo sigue siendo cupo agotado`, () => {
      const tr = translator();
      tr.translate(limit);
      const events = tr.translate(result({ subtype: 'error_during_execution', errors: [] }));
      expect(payload(events, 'error')[0]?.code).toBe('quota_exhausted');
    });
  }
});

describe('otros mensajes', () => {
  it('subagentes anidados: el nieto cuelga del subagente que lo lanzó', () => {
    const events = translateAll([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { subagent_type: 'Explore', description: 'buscar' } }] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_A', message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'Task', input: { description: 'sub-búsqueda' } }] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_B', message: { content: [{ type: 'text', text: 'hola desde el nieto' }] } },
      { type: 'system', subtype: 'task_progress', task_id: 't-b', tool_use_id: 'toolu_B', description: 'sub-búsqueda', last_tool_name: 'Grep', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 } },
      { type: 'system', subtype: 'task_updated', task_id: 't-b', patch: { status: 'failed', error: 'sin resultados' } },
    ]);
    const grandchild = events.filter((e) => e.sessionId === 'toolu_B');
    expect(grandchild.every((e) => e.parentSessionId === 'toolu_A')).toBe(true);
    expect(events.filter((e) => e.sessionId === 'toolu_A').every((e) => e.parentSessionId === MAIN)).toBe(true);
    expect(payload(events, 'tool_call')[1]).toEqual({ callId: 'toolu_B', name: 'Task', inputSummary: 'general-purpose: sub-búsqueda' });
    expect(grandchild.filter((e) => e.type === 'status').map((e) => e.payload)).toEqual([
      { state: 'running', detail: 'subagente' },
      { state: 'running', detail: 'sub-búsqueda · última herramienta: Grep · 10 tokens, 1 herramientas' },
      { state: 'failed', detail: 'sin resultados' },
    ]);
  });

  it('tacha claves en texto, entradas de herramientas y resultados', () => {
    const events = translateAll([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `la clave es ${FAKE_KEY}` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "x-api-key: ${FAKE_KEY}" https://x` } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `eco ${FAKE_KEY}` }] } },
    ]);
    const text = JSON.stringify(events);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain('[REDACTADO]');
  });

  it('recorta entradas largas a 300 caracteres y resume por herramienta', () => {
    const events = translateAll([{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: 'a.ts', content: 'x' } }, { type: 'tool_use', id: 'u', name: 'Mcp', input: { data: 'y'.repeat(1000) } }] } }]);
    const [write, mcp] = payload(events, 'tool_call');
    expect(write?.inputSummary).toBe('a.ts');
    expect(mcp?.inputSummary.length).toBe(SUMMARY_MAX);
    expect(mcp?.inputSummary.endsWith('…')).toBe(true);
    expect(describeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('foo en src');
    expect(describeToolInput('Bash', { command: 'npm test' })).toBe('npm test');
    expect(truncate('a\n\n  b')).toBe('a b');
    expect(toolResultText([{ type: 'text', text: 'uno' }, { type: 'image', source: {} }])).toBe('uno [image]');
  });

  it('con detailMax el resultado y la entrada no se cortan a 300 y conservan los saltos de línea', () => {
    const long = `{\n  "a": 1,\n${'x'.repeat(4990)}\n}`;
    const messages = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'r1', name: 'Mcp', input: { plan: 'p'.repeat(1000) } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: long }] } },
    ];
    const wide = new ClaudeSdkTranslator({ agentId: 'claude-main', sessionId: MAIN, secrets: [FAKE_KEY], detailMax: 8000 });
    const [call] = payload(translateAll(messages, wide), 'tool_call');
    const [result] = payload(translateAll(messages, wide), 'tool_result');
    expect(result?.summary).toBe(long);
    expect(call?.inputSummary.length).toBeGreaterThan(1000);
    // El traductor por defecto (flota, terminal) sigue con una línea de 300.
    expect(payload(translateAll(messages), 'tool_result')[0]?.summary.length).toBe(SUMMARY_MAX);
  });

  it('emite file_change al confirmarse una edición (add si Write crea, modify si no)', () => {
    const events = translateAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: `${WORKTREE}\\src\\nuevo.ts`, content: '' } },
            { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'src/viejo.ts', old_string: 'a', new_string: 'b' } },
            { type: 'tool_use', id: 'x', name: 'Edit', input: { file_path: 'src/falla.ts', old_string: 'a', new_string: 'b' } },
          ],
        },
      },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] }, tool_use_result: { type: 'create', filePath: 'x' } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: 'ok' }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'no encontrado', is_error: true }] } },
    ]);
    expect(payload(events, 'file_change')).toEqual([
      { path: 'src/nuevo.ts', change: 'add' },
      { path: 'src/viejo.ts', change: 'modify' },
    ]);
    expect(payload(events, 'tool_result').map((p) => p.ok)).toEqual([true, true, false]);
  });

  it('lo desconocido sale como raw y lo ruidoso se ignora', () => {
    const events = translateAll([
      { type: 'tipo_nuevo', dato: 1 },
      { type: 'system', subtype: 'subtipo_nuevo' },
      'no es un objeto',
      { type: 'tool_progress', tool_use_id: 'x', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 1 },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 },
      { type: 'assistant', message: { content: 'no es un arreglo' } },
    ]);
    expect(events.map((e) => (e.type === 'raw' ? e.payload.source : e.type))).toEqual([
      'claude-sdk:tipo_nuevo',
      'claude-sdk:system/subtipo_nuevo',
      'claude-sdk',
      'claude-sdk:assistant',
    ]);
  });

  it('el aviso terminal de una tarea de otro proceso (sin tool_use_id) no abre una sesión task-*', () => {
    const notice = { type: 'system', subtype: 'task_notification', task_id: 'ae2bd0d', status: 'stopped', reason: 'worker_restart', summary: `Background agent "x" didn't finish before the previous session ended` };
    const events = translateAll([notice]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.sessionId === MAIN && e.type !== 'status')).toBe(true);
    // Una tarea conocida de este proceso sí se cierra en su sesión.
    const tr = translator();
    translateAll([{ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_1', description: 'buscar' }], tr);
    const closed = translateAll([{ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'stopped', summary: 'cortado' }], tr);
    expect(closed.map((e) => [e.sessionId, e.type === 'status' && e.payload.state])).toEqual([['toolu_1', 'cancelled']]);
  });

  it('el pensamiento visible sale como thinking-summary; el vacío se omite', () => {
    const events = translateAll([{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'Planeo leer el archivo.' }] } }]);
    expect(payload(events, 'text')).toEqual([{ text: 'Planeo leer el archivo.', role: 'thinking-summary' }]);
  });

  it('usage_report alimenta el costo en curso; rate_limit rechazado deja pista de cupo', () => {
    const tr = translator();
    tr.translate({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [] },
      usage_report: { session: { total_cost_usd: 1.5, model_usage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 5, costUSD: 1.5 } } } },
    });
    expect(tr.costUsd).toBe(1.5);
    expect(tr.partialUsageEvents()[0]?.payload).toMatchObject({ costUsd: 1.5, model: 'claude-opus-5-5' });
    const events = tr.translate({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    expect(events[0]?.payload).toMatchObject({ state: 'waiting' });
    expect(tr.hint?.code).toBe('quota_exhausted');
  });
});
