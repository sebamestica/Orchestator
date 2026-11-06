/**
 * Uso y gasto de la mente al reanudar su sesión (issue uso-real-02): el proceso reanudado trae los acumulados que
 * restaura Claude Code, así que solo se cuenta lo que gasta ese proceso, no el acumulado entero otra vez.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addUsage, bench, closeBenches, meteredTurn, tick, usageCost, type ChatBench, type MeteredProcess, type TurnUsage } from './helpers.ts';

afterEach(closeBenches);

const T1: TurnUsage = { input: 40, cached: 60, output: 10 };
const T2: TurnUsage = { input: 20, cached: 30, output: 5 };
const T3: TurnUsage = { input: 30, cached: 50, output: 8 };
/** Entrada total que se guarda por turno (sin caché + leída de caché). */
const inputOf = (u: TurnUsage) => u.input + u.cached;

async function turn(b: ChatBench, chatId: string, text: string): Promise<void> {
  await b.service.send(chatId, { text });
  await b.settle(chatId);
}

/** Espera a que la sesión ociosa se cierre (el mensaje siguiente la reanuda con `resume`). */
async function idleClose(b: ChatBench): Promise<void> {
  for (let i = 0; i < 200 && b.q.closed === 0; i++) await tick(10);
  expect(b.q.closed).toBe(1);
}

function rows(b: ChatBench, sessionId: string): { input: number; cost: number }[] {
  return b.store.database.prepare('SELECT input_tokens AS input, cost_usd AS cost FROM usage WHERE session_id = ? ORDER BY id').all(sessionId) as { input: number; cost: number }[];
}

async function run(plan: readonly MeteredProcess[], first: readonly string[], second: readonly string[]) {
  const b = await bench({ idleMs: 50, turn: meteredTurn(plan) });
  const chat = b.service.create({ projectId: 'demo' });
  for (const text of first) await turn(b, chat.id, text);
  await idleClose(b);
  const before = rows(b, chat.sessionId).length;
  for (const text of second) await turn(b, chat.id, text);
  expect(b.q.calls[1]?.options.resume).toBe('sdk-1');
  const all = rows(b, chat.sessionId);
  return {
    b,
    chat,
    resumedRows: all.slice(before),
    input: all.reduce((s, r) => s + r.input, 0),
    cost: b.service.get(chat.id).costUsd,
  };
}

describe('ChatService: uso de la mente al reanudar la sesión', () => {
  it('cuenta solo lo que gasta el proceso reanudado, no el acumulado restaurado otra vez', async () => {
    const r = await run([{ turns: [T1] }, { restored: T1, turns: [T2] }], ['uno'], ['dos']);
    // Antes del arreglo: 2·c1 + c2 y 250 tokens de entrada.
    expect(r.cost).toBeCloseTo(usageCost(T1) + usageCost(T2), 9);
    expect(r.b.store.spentUsd('orquestador')).toBeCloseTo(usageCost(T1) + usageCost(T2), 9);
    expect(r.input).toBe(inputOf(T1) + inputOf(T2));
  });

  it('un resultado que solo restaura el acumulado (sin llamadas a la API) no guarda gasto', async () => {
    const r = await run([{ turns: [T1] }, { restored: T1, turns: [null, T2] }], ['uno'], ['dos']);
    expect(r.resumedRows.filter((row) => row.cost > 0)).toEqual([]);
    expect(r.cost).toBeCloseTo(usageCost(T1), 9);
  });

  it('tras un resultado que solo restaura, el turno siguiente cuenta solo lo suyo', async () => {
    const r = await run([{ turns: [T1] }, { restored: T1, turns: [null, T2] }], ['uno'], ['dos', 'tres']);
    expect(r.cost).toBeCloseTo(usageCost(T1) + usageCost(T2), 9);
    expect(r.input).toBe(inputOf(T1) + inputOf(T2));
  });

  it('con una foto vieja (restaura menos de lo ya guardado) no se pierde ni se duplica el gasto', async () => {
    const r = await run([{ turns: [T1, T3] }, { restored: T1, turns: [T2] }], ['uno', 'dos'], ['tres']);
    // Antes del arreglo: 330 tokens de entrada (el proceso 2 guardaba entero su acumulado de 150).
    expect(r.input).toBe(inputOf(addUsage(T1, T3, T2)));
    expect(r.cost).toBeCloseTo(usageCost(T1) + usageCost(T3) + usageCost(T2), 9);
  });
});
