import { describe, expect, it } from 'vitest';
import { createClaudePlannerLlm, PLANNER_EFFORT, PLANNER_MODEL } from '../../../src/core/app/planner.ts';
import { agentConfigSchema } from '../../../src/shared/index.ts';

const config = agentConfigSchema.parse({ id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Claude', model: 'claude-opus-5-5' });

/** `fetch` que guarda el cuerpo de `POST /v1/messages` y responde con un mensaje mínimo del modelo pedido. */
function capture() {
  const bodies: { model?: string; output_config?: { effort?: string } }[] = [];
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; output_config?: { effort?: string } };
    bodies.push(body);
    return new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { bodies, fetchFn };
}

const request = { system: 'Eres el planificador.', messages: [{ role: 'user' as const, content: '1. A' }] };

describe('planificador: modelo y esfuerzo (issue 6)', () => {
  it('por defecto Sonnet 5.5 en esfuerzo low, aunque el agente use Opus', async () => {
    const { bodies, fetchFn } = capture();
    await createClaudePlannerLlm({ credentials: async () => ({ config, apiKey: 'sk-ant-falsa-0000000000' }), fetch: fetchFn, maxRetries: 0 }).complete(request);
    expect(PLANNER_MODEL).toBe('claude-sonnet-5-5');
    expect(PLANNER_EFFORT).toBe('low');
    expect(bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'low' } });
  });

  it('model: null usa el modelo del agente; model y effort explícitos mandan', async () => {
    const { bodies, fetchFn } = capture();
    const creds = async () => ({ config, apiKey: 'sk-ant-falsa-0000000000' });
    await createClaudePlannerLlm({ credentials: creds, fetch: fetchFn, maxRetries: 0, model: null }).complete(request);
    await createClaudePlannerLlm({ credentials: creds, fetch: fetchFn, maxRetries: 0, model: 'claude-haiku-5-5', effort: 'medium' }).complete(request);
    expect(bodies.map((b) => [b.model, b.output_config?.effort])).toEqual([['claude-opus-5-5', 'low'], ['claude-haiku-5-5', 'medium']]);
  });
});
