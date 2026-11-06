import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../../../src/core/adapters/claude-sdk/pricing.ts';
import { DEFAULT_SETTINGS, type MindLimits, type Settings } from '../../../src/shared/index.ts';
import { usageEvent } from '../store/fixture-events.ts';
import { bench, closeBenches, sdkInit, sdkResult, sdkText, type ChatBench, type TurnFn } from './helpers.ts';
import { promptBlocks } from '../conductor/fakes.ts';

afterEach(closeBenches);

const optionsOf = (b: ChatBench, i = 0): Options => {
  const o = b.q.calls[i]?.options;
  if (!o) throw new Error(`query ${i} no se llamó`);
  return o;
};

const withLimits = (limits: Partial<MindLimits>): Settings => ({ ...DEFAULT_SETTINGS, mindLimits: { ...DEFAULT_SETTINGS.mindLimits, ...limits } });

let seq = 0;
/** Gasto de la mente registrado hoy en otro chat (como lo guarda el hub). */
function spentToday(b: ChatBench, usd: number): void {
  b.store.append(usageEvent('chat-otro', 'orquestador', seq++, new Date().toISOString(), { inputTokens: 1, outputTokens: 1, costUsd: usd }));
}

/** Mensaje del asistente que cuesta unos 0,02 USD (1.000 tokens de salida de opus 5.5). */
const OUT = { input_tokens: 0, output_tokens: 1_000 };
const OUT_USD = estimateCostUsd('claude-opus-5-5', { input: 0, output: 1_000, cacheRead: 0, cacheWrite: 0 });

const sidOf = (o: Options, process: number) => (typeof o.resume === 'string' ? o.resume : `sdk-${process}`);

/** Turno caro: cuatro mensajes de ~0,02 USD antes del `result`. */
const costlyTurn: TurnFn = (_m, ctx) => {
  const sid = sidOf(ctx.options, ctx.process);
  return [sdkInit(sid), ...[1, 2, 3, 4].map((i) => sdkText(`paso ${i}`, sid, null, OUT)), sdkResult('terminé', sid, 0.08)];
};

const lastAssistant = (b: ChatBench, chatId: string) => b.service.messages(chatId).filter((m) => m.role === 'assistant').at(-1)?.text ?? '';

describe('ChatService: topes de gasto de la mente', () => {
  it('el precio de prueba es el esperado (~0,02 USD por mensaje)', () => {
    expect(OUT_USD).toBeCloseTo(0.02, 9);
  });

  it('tope diario: la sesión lleva lo que queda del día y un envío con el tope agotado falla, también con la sesión viva', async () => {
    const b = await bench({ settings: withLimits({ dayUsd: 1 }) });
    spentToday(b, 0.9);
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    expect(optionsOf(b).maxBudgetUsd).toBeCloseTo(0.1, 9);
    expect(optionsOf(b).maxTurns).toBe(200);
    expect(b.service.sessionOf(chat.id)?.closed).toBe(false);
    // 0,9 + 0,01 (el eco) + 0,09: justo el tope, aunque la suma quede en 0,99999….
    spentToday(b, 0.09);
    await expect(b.service.send(chat.id, { text: 'otra' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/tope diario/) });
    // El chat no queda ocupado: con el tope quitado, el mensaje pasa.
    b.settings.value = withLimits({ dayUsd: null });
    await b.service.send(chat.id, { text: 'otra' });
    await b.settle(chat.id);
    expect(lastAssistant(b, chat.id)).toBe('eco: otra');
  });

  it('el tope de la sesión es el menor entre el presupuesto del agente y lo que queda del día', async () => {
    const b = await bench({ settings: withLimits({ dayUsd: 1 }), budgetLeftUsd: () => 0.4 });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    expect(optionsOf(b).maxBudgetUsd).toBeCloseTo(0.4, 9);
  });

  it('tope por turno: corta el turno en vivo, deja el chat en idle y avisa el tope en la respuesta', async () => {
    const b = await bench({ settings: withLimits({ turnUsd: 0.05 }), turn: costlyTurn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga todo' });
    await b.settle(chat.id);
    expect(b.q.interrupted).toBe(1);
    expect(b.service.get(chat.id).state).toBe('idle');
    expect(lastAssistant(b, chat.id)).toMatch(/tope por turno: 0,05 USD/);
    expect(lastAssistant(b, chat.id)).toMatch(/sigue/);
    // «sigue» abre otra cuenta: el siguiente turno vuelve a tener el tope entero.
    b.settings.value = withLimits({ turnUsd: 1 });
    await b.service.send(chat.id, { text: 'sigue' });
    await b.settle(chat.id);
    expect(b.q.interrupted).toBe(1);
  });

  it('la cuenta del tope vuelve a cero con cada mensaje del usuario, también con la sesión viva', async () => {
    // Cada turno cuesta ~0,04 USD: bajo el tope de 0,05, aunque la suma de los dos lo pase.
    const b = await bench({
      settings: withLimits({ turnUsd: 0.05 }),
      turn: (_m, ctx) => {
        const sid = sidOf(ctx.options, ctx.process);
        return [...(ctx.index === 0 ? [sdkInit(sid)] : []), sdkText('uno', sid, null, OUT), sdkText('dos', sid, null, OUT), sdkResult('listo', sid, 0.04 * (ctx.index + 1))];
      },
    });
    const chat = b.service.create({ projectId: 'demo' });
    for (const text of ['primero', 'segundo']) {
      await b.service.send(chat.id, { text });
      await b.settle(chat.id);
    }
    expect(b.q.calls).toHaveLength(1);
    expect(b.q.interrupted).toBe(0);
    expect(lastAssistant(b, chat.id)).toBe('listo');
  });

  it('tope por turno con un subagente vivo: cierra la sesión (lo corta) y avisa en la respuesta', async () => {
    const b = await bench({
      settings: withLimits({ turnUsd: 0.05 }),
      turn: (_m, ctx) => {
        const sid = sidOf(ctx.options, ctx.process);
        const started = { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', description: 'Leer todo', subagent_type: 'general-purpose', session_id: sid, uuid: '00000000-0000-4000-8000-00000000aaaa' } as unknown as SDKMessage;
        // Sin `result`: al cerrar la sesión, el SDK ya no lo manda.
        return [sdkInit(sid), started, ...[1, 2, 3, 4].map((i) => sdkText(`leo ${i}`, sid, 'tu1', OUT))];
      },
    });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'lee todo el repo' });
    await b.settle(chat.id);
    expect(b.q.closed).toBe(1);
    expect(b.q.interrupted).toBe(0);
    expect(b.service.get(chat.id).backgroundTasks).toBeUndefined();
    expect(b.service.get(chat.id).state).toBe('idle');
    expect(lastAssistant(b, chat.id)).toMatch(/tope por turno: 0,05 USD/);
    // Lo gastado hasta el corte (tres mensajes) queda guardado: cuenta en el chat y en el tope diario.
    expect(b.service.get(chat.id).costUsd).toBeCloseTo(3 * OUT_USD, 6);
    expect(b.store.spentUsd('orquestador')).toBeCloseTo(3 * OUT_USD, 6);
  });

  it('un envío negado por el tope diario no deja la sesión viva sin plazo de inactividad', async () => {
    const b = await bench({ settings: withLimits({ dayUsd: 1 }), idleMs: 150 });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    spentToday(b, 1);
    // El envío llega antes del plazo de inactividad: la sesión sigue viva cuando se niega.
    await expect(b.service.send(chat.id, { text: 'otra' })).rejects.toMatchObject({ code: 'conflict' });
    expect(b.q.closed).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(b.q.closed).toBe(1);
    expect(b.service.sessionOf(chat.id)).toBeUndefined();
  });

  it('la cabecera del chat se mueve durante el turno, antes del result', async () => {
    const b = await bench({
      turn: (_m, ctx) => {
        const sid = sidOf(ctx.options, ctx.process);
        return [sdkInit(sid), sdkText('paso', sid, null, OUT), sdkResult('listo', sid, 0.03)];
      },
    });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    const running = b.sent('chat').filter((m) => m.chat.id === chat.id && m.chat.state === 'running');
    expect(running.some((m) => Math.abs(m.chat.costUsd - OUT_USD) < 1e-9)).toBe(true);
    // Tras el result manda el costo informado por el SDK, sin sumar la estimación en curso.
    expect(b.service.get(chat.id).costUsd).toBeCloseTo(0.03, 9);
  });

  it('una sesión reanudada no se corta por el acumulado que restaura el SDK', async () => {
    const turn: TurnFn = (m, ctx) => {
      const sid = sidOf(ctx.options, ctx.process);
      const text = typeof m.message.content === 'string' ? m.message.content : '';
      if (ctx.process === 1) return [sdkInit(sid), sdkText(`eco: ${text}`, sid), sdkResult(`eco: ${text}`, sid, 0.01)];
      // Proceso reanudado: el primer informe trae los 10 USD de la conversación anterior.
      const restored = { ...(sdkText('sigo', sid) as object), usage_report: { session: { total_cost_usd: 10 } } } as unknown as SDKMessage;
      return [sdkInit(sid), restored, sdkText('listo', sid), sdkResult('listo', sid, 10.01)];
    };
    const b = await bench({ settings: withLimits({ turnUsd: 0.05 }), turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    // Cambiar el modo recrea la sesión, reanudada.
    b.service.patch(chat.id, { mode: 'auto' });
    await b.service.send(chat.id, { text: 'sigue' });
    await b.settle(chat.id);
    expect(b.q.calls).toHaveLength(2);
    expect(optionsOf(b, 1).resume).toBe('sdk-1');
    expect(b.q.interrupted).toBe(0);
    expect(lastAssistant(b, chat.id)).toBe('listo');
  });

  it('los topes vigentes van en el prompt de la sesión y el prefijo ya no dice «sin tope»', async () => {
    const b = await bench({ settings: withLimits({ turnUsd: 2, dayUsd: null, maxAutonomousTurns: 3 }) });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    const prompt = promptBlocks(optionsOf(b)).join('\n');
    expect(prompt).not.toMatch(/sin tope de cupo/);
    expect(prompt).toMatch(/Tope por mensaje del usuario: 2 USD/);
    expect(prompt).toMatch(/Tope diario de la mente: sin tope/);
    expect(prompt).toMatch(/Turnos seguidos sin mensaje del usuario: 3/);
  });
});
