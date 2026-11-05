import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translateAgyEvent, type EventBody } from '../../../src/core/adapters/agy-cli/translate.ts';
import { translateCodexEvent } from '../../../src/core/adapters/codex-cli/translate.ts';
import { usageSchema, type Usage } from '../../../src/shared/index.ts';

/** Uso normalizado (issue 5): entrada total con la caché dentro, caché escrita aparte y el modelo en el evento. */

const fixture = (rel: string) => readFileSync(new URL(`../../../fixtures/${rel}`, import.meta.url), 'utf8');
const lines = (rel: string) => fixture(rel).split(/\r?\n/).filter((l) => l.trim());
const usages = (bodies: EventBody[]): Usage[] => bodies.flatMap((b) => (b.type === 'usage' ? [usageSchema.parse(b.payload)] : []));

describe('agy: uso normalizado', () => {
  it('stream-edit-command.jsonl: cada paso lleva el modelo del init y la caché escrita en 0', () => {
    const bodies = lines('agy/stream-edit-command.jsonl').flatMap((l) => translateAgyEvent(JSON.parse(l), l));
    expect(usages(bodies)).toEqual([
      { inputTokens: 12875, outputTokens: 44, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, model: 'gemini-3.8-flash-low' },
      { inputTokens: 12995, outputTokens: 36, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, model: 'gemini-3.8-flash-low' },
      { inputTokens: 13119, outputTokens: 193, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, model: 'gemini-3.8-flash-low' },
    ]);
  });

  it('stream-ok.jsonl: sin modelo en el init usa el configurado (y sin ninguno no inventa)', () => {
    const run = (opts?: { model?: string }) => usages(lines('agy/stream-ok.jsonl').flatMap((l) => translateAgyEvent(JSON.parse(l), l, opts)));
    expect(run()).toEqual([{ inputTokens: 7354, outputTokens: 34, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 33 }]);
    expect(run({ model: 'gemini-3.8-flash-high' })[0]?.model).toBe('gemini-3.8-flash-high');
  });

  it('la entrada pasa a incluir la caché leída (cifras reales de la base del 2026-11-04)', () => {
    // agy guardaba input_tokens SIN la caché: en sus filas reales lo leído supera a la entrada (6699 vs 16741).
    const value = {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-real-1',
        step_index: 7,
        state: 'DONE',
        step_type: 'agent_response',
        usage: { input_tokens: 6699, output_tokens: 660, thinking_tokens: 605, cache_read_tokens: 16741, total_tokens: 24100 },
      },
    };
    expect(usages(translateAgyEvent(value, JSON.stringify(value)))).toEqual([
      { inputTokens: 6699 + 16741, outputTokens: 660, cachedInputTokens: 16741, cacheWriteTokens: 0, reasoningTokens: 605 },
    ]);
  });

  it('el modelo se recuerda por conversación y se olvida con su result', () => {
    const id = 'conv-modelo-1';
    const step = { event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 1 } } };
    const other = { ...step, step_update: { ...step.step_update, conversation_id: 'conv-modelo-2' } };
    translateAgyEvent({ event: 'init', conversation_id: id, init: { model: 'gemini-3.8-flash-medium' } }, '');
    expect(usages(translateAgyEvent(step, ''))[0]?.model).toBe('gemini-3.8-flash-medium');
    expect(usages(translateAgyEvent(other, ''))[0]?.model).toBeUndefined();
    translateAgyEvent({ event: 'result', result: { conversation_id: id, status: 'SUCCESS' } }, '');
    expect(usages(translateAgyEvent(step, ''))[0]?.model).toBeUndefined();
  });
});

describe('Codex: uso normalizado', () => {
  it('exec-ok.jsonl: la caché escrita del evento real (cache_write_input_tokens) y el modelo configurado', () => {
    const run = (opts?: { model?: string }) => usages(lines('codex/exec-ok.jsonl').flatMap((l) => translateCodexEvent(JSON.parse(l), l, opts)));
    expect(run()).toEqual([{ inputTokens: 22572, outputTokens: 5, cachedInputTokens: 13440, cacheWriteTokens: 0, reasoningTokens: 0 }]);
    expect(run({ model: 'gpt-5.5-codex' })).toEqual([{ inputTokens: 22572, outputTokens: 5, cachedInputTokens: 13440, cacheWriteTokens: 0, reasoningTokens: 0, model: 'gpt-5.5-codex' }]);
  });

  it('un turno que escribe en caché lo informa aparte, dentro de la entrada', () => {
    const value = { type: 'turn.completed', usage: { input_tokens: 69035, cached_input_tokens: 59136, cache_write_input_tokens: 4096, output_tokens: 127, reasoning_output_tokens: 0 } };
    expect(usages(translateCodexEvent(value, JSON.stringify(value)))).toEqual([
      { inputTokens: 69035, outputTokens: 127, cachedInputTokens: 59136, cacheWriteTokens: 4096, reasoningTokens: 0 },
    ]);
  });
});
