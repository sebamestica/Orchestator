import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentEvent, QuotaSnapshot, Usage } from '../../../src/shared/index.ts';

const root = join(import.meta.dirname, '..', '..', '..', 'fixtures');

function jsonl(rel: string): unknown[] {
  return readFileSync(join(root, rel), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}

const codexTurn = z.object({
  type: z.literal('turn.completed'),
  usage: z.object({
    input_tokens: z.number().int(),
    cached_input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    reasoning_output_tokens: z.number().int(),
  }),
});

/** Uso real de `codex exec --json` (fixtures/codex/exec-ok.jsonl). */
export function codexUsage(): Usage {
  const turn = jsonl('codex/exec-ok.jsonl')
    .map((v) => codexTurn.safeParse(v))
    .find((r) => r.success);
  if (!turn?.success) throw new Error('El fixture de Codex no tiene turn.completed');
  const u = turn.data.usage;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedInputTokens: u.cached_input_tokens,
    reasoningTokens: u.reasoning_output_tokens,
    model: 'gpt-5-codex',
  };
}

const agyStep = z.object({
  event: z.literal('step_update'),
  step_update: z.object({
    usage: z.object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      thinking_tokens: z.number().int(),
      cache_read_tokens: z.number().int(),
    }),
  }),
});

/** Uso por paso de agy `stream-json` (fixtures/agy/stream-ok.jsonl). */
export function agyUsages(): Usage[] {
  return jsonl('agy/stream-ok.jsonl')
    .map((v) => agyStep.safeParse(v))
    .filter((r) => r.success)
    .map((r) => {
      const u = r.data.step_update.usage;
      return {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        reasoningTokens: u.thinking_tokens,
        cachedInputTokens: u.cache_read_tokens,
        model: 'gemini-pro',
      };
    });
}

const agyUsageFile = z.object({
  command: z.object({
    data: z.object({
      groups: z.array(
        z.object({
          name: z.string(),
          buckets: z.array(
            z.object({ id: z.string(), window: z.enum(['5h', 'weekly']), remaining_fraction: z.number(), reset_time: z.string() }),
          ),
        }),
      ),
    }),
  }),
});

/** Foto de cupo construida desde la salida real de `agy -p "/usage"` (fixtures/agy/usage.json). */
export function agyQuota(agentId: string, takenAt: string): QuotaSnapshot {
  const data = agyUsageFile.parse(JSON.parse(readFileSync(join(root, 'agy', 'usage.json'), 'utf8')));
  return {
    agentId,
    method: 'agy-usage',
    takenAt,
    stale: false,
    buckets: data.command.data.groups.flatMap((g) =>
      g.buckets.map((b) => ({
        groupId: b.id,
        groupName: g.name,
        window: b.window,
        remainingFraction: b.remaining_fraction,
        resetAt: new Date(b.reset_time).toISOString(),
      })),
    ),
  };
}

export function usageEvent(sessionId: string, agentId: string, seq: number, ts: string, payload: Usage): AgentEvent {
  return { sessionId, agentId, seq, ts, type: 'usage', payload };
}

export function textEvent(sessionId: string, agentId: string, seq: number, ts: string, text: string): AgentEvent {
  return { sessionId, agentId, seq, ts, type: 'text', payload: { text, role: 'assistant' } };
}
