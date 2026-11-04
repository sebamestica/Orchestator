/**
 * Prueba en vivo mínima del orquestador (gasta saldo de la clave: un turno, esfuerzo bajo y tope de 0,50 USD).
 * Solo con ORQ_LIVE=1 y la clave en el entorno. Desde WSL (el indicador de WSLENV es /w, no /u):
 *   WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/conductor.live.test.ts"
 * Puertos falsos; el modelo debe llamar a `cupos` y responder con el número de agentes (3).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConductorSession, mcpToolName } from '../../src/core/conductor/index.ts';
import { redactSecrets } from '../../src/shared/index.ts';
import { FakeQuotas, fakePorts, fixtureQuotas } from '../core/conductor/fakes.ts';

const live = process.env.ORQ_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!live)('orquestador en vivo', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orq-conductor-live-'));
  });
  afterAll(async () => {
    // Tras close() el CLI tarda unos segundos en salir y en Windows retiene la carpeta (EPERM).
    for (let attempt = 0; dir && attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  it('llama a cupos y responde con el número de agentes', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    const quotas = [
      ...(await fixtureQuotas()),
      { agentId: 'claude-api', method: 'manual-budget' as const, takenAt: '2026-11-01T22:00:00.000Z', stale: false,
        buckets: [{ groupId: 'usd', groupName: 'Presupuesto', window: 'monthly' as const, remainingFraction: 0.8 }] },
    ];
    const env: Record<string, string> = { ANTHROPIC_API_KEY: apiKey };
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    const stderr: string[] = [];
    const session = new ConductorSession({
      ports: { ...fakePorts(), quotas: new FakeQuotas(quotas) },
      projectId: 'demo',
      cwd: dir,
      env,
      effort: 'low',
      maxBudgetUsd: 0.5,
      maxTurns: 4,
      onStderr: (line) => stderr.push(line),
    });
    const messages: SDKMessage[] = [];
    const started = Date.now();
    try {
      session.send('Llama a la herramienta cupos y responde solo con el número de agentes que aparecen, en cifras.');
      for await (const message of session.messages()) {
        messages.push(message);
        if (message.type === 'result') break;
      }
    } finally {
      session.close();
    }
    const seconds = (Date.now() - started) / 1000;
    const result = messages.find((m) => m.type === 'result');
    const toolUses = messages.flatMap((m) =>
      m.type === 'assistant' ? m.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name) : [],
    );
    const answer = result?.type === 'result' && result.subtype === 'success' ? result.result : '';
    console.warn(redactSecrets(JSON.stringify({
      segundos: seconds,
      subtipo: result?.type === 'result' ? result.subtype : null,
      costoUsd: result?.type === 'result' ? result.total_cost_usd : null,
      turnos: result?.type === 'result' ? result.num_turns : null,
      herramientas: toolUses,
      respuesta: answer,
      stderr: stderr.slice(-5),
    }), [apiKey]));

    expect(result?.type === 'result' && result.subtype).toBe('success');
    expect(toolUses).toContain(mcpToolName('cupos'));
    expect(toolUses.some((n) => /^(Bash|Edit|Write|PowerShell)$/.test(n))).toBe(false);
    expect(answer).toMatch(/\b3\b/);
    expect(JSON.stringify(messages)).not.toContain(apiKey);
  }, 240_000);
});
