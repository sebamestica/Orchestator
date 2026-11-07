/** Issue ui-chat-08: escribirle a la mente mientras trabaja («Ahora» entra al turno; «Al terminar» espera en la cola). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MID_TURN_NOTE } from '../../../src/core/conductor/index.ts';
import { bench, closeBenches, echoTurn, sdkInit, sdkResult, sdkText, type ChatBench, type TurnFn } from './helpers.ts';

afterEach(closeBenches);

/**
 * El primer mensaje del proceso espera a `release()`; los demás responden con eco al instante. `pendingInSdk`: el
 * `queued_turn_count` del `result` del primer turno (envíos del usuario que el SDK todavía tiene por contestar).
 */
function gated(pendingInSdk?: number) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const turn: TurnFn = async (message, ctx) => {
    if (ctx.index > 0) return echoTurn(message, ctx);
    await Promise.race([gate, ctx.stopped]);
    const result = sdkResult('listo', 'sdk-1', 0.01);
    return [sdkInit('sdk-1'), sdkText('listo', 'sdk-1'), pendingInSdk === undefined ? result : ({ ...result, queued_turn_count: pendingInSdk } as SDKMessage)];
  };
  return { turn, release: () => release() };
}

const thread = (b: ChatBench, chatId: string) => b.service.messages(chatId).map((m) => [m.role, m.text]);
const contentOf = (m: SDKUserMessage | undefined) => m?.message.content;

describe('enviar con la mente ocupada', () => {
  it('«al terminar» no da 409: queda en la cola del chat y se envía solo al terminar el turno, en orden', async () => {
    const g = gated();
    const b = await bench({ turn: g.turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });

    const dos = await b.service.submit(chat.id, { text: 'dos', delivery: 'after-turn' });
    const tres = await b.service.submit(chat.id, { text: 'tres', delivery: 'after-turn' });
    expect('queued' in dos && dos.queued.text).toBe('dos');
    expect('queued' in tres && tres.chat.queued?.map((q) => q.text)).toEqual(['dos', 'tres']);
    // La cola vive en el núcleo: quien vuelva a abrir el chat la ve.
    expect(b.service.get(chat.id).queued?.map((q) => q.text)).toEqual(['dos', 'tres']);
    expect(thread(b, chat.id)).toEqual([['user', 'largo']]);
    expect(b.q.received).toHaveLength(1);

    g.release();
    await vi.waitFor(
      () =>
        expect(thread(b, chat.id)).toEqual([
          ['user', 'largo'],
          ['assistant', 'listo'],
          ['user', 'dos'],
          ['assistant', 'eco: dos'],
          ['user', 'tres'],
          ['assistant', 'eco: tres'],
        ]),
      { timeout: 5_000 },
    );
    await b.settle(chat.id);
    expect(b.q.received.map(contentOf)).toEqual(['largo', 'dos', 'tres']);
    expect(b.service.get(chat.id).queued).toBeUndefined();
  });

  it('quitar un mensaje de la cola: no se envía', async () => {
    const g = gated();
    const b = await bench({ turn: g.turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });
    const r = await b.service.submit(chat.id, { text: 'mejor no', delivery: 'after-turn' });
    if (!('queued' in r)) throw new Error('no quedó en cola');

    expect(b.service.unqueue(chat.id, r.queued.id).queued).toBeUndefined();
    expect(() => b.service.unqueue(chat.id, r.queued.id)).toThrow(expect.objectContaining({ code: 'not_found' }));

    g.release();
    await b.settle(chat.id);
    await vi.waitFor(() => expect(thread(b, chat.id)).toEqual([['user', 'largo'], ['assistant', 'listo']]));
    expect(b.q.received).toHaveLength(1);
  });

  it('«ahora» no da 409 ni corta el turno: el mensaje queda en el hilo y entra a la entrada del SDK con priority next', async () => {
    const g = gated();
    const b = await bench({ turn: g.turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });

    const r = await b.service.submit(chat.id, { text: 'y esto también', delivery: 'now' });
    expect('message' in r && r.message).toMatchObject({ role: 'user', text: 'y esto también' });
    expect(thread(b, chat.id)).toEqual([['user', 'largo'], ['user', 'y esto también']]);
    expect(b.service.get(chat.id).queued).toBeUndefined();
    expect(b.q.interrupted).toBe(0);
    // Sin `delivery`, como siempre: 409.
    await expect(b.service.submit(chat.id, { text: 'otro' })).rejects.toMatchObject({ code: 'conflict' });

    g.release();
    await vi.waitFor(() => expect(b.q.received).toHaveLength(2));
    // mente-10: a la mente le llega marcado como mensaje a mitad de su trabajo; en el hilo queda tal cual lo escribió el usuario.
    expect(b.q.received[1]).toMatchObject({ type: 'user', priority: 'next', message: { content: `${MID_TURN_NOTE}\ny esto también` } });
    expect(b.q.received[0]?.priority).toBeUndefined();
    // Si el SDK no lo incorporó al turno, lo corre como turno propio y su respuesta también queda en el hilo.
    await vi.waitFor(() =>
      expect(thread(b, chat.id)).toEqual([
        ['user', 'largo'],
        ['user', 'y esto también'],
        ['assistant', 'listo'],
        ['assistant', `eco: ${MID_TURN_NOTE}\ny esto también`],
      ]),
    );
    await b.settle(chat.id);
    expect(b.q.interrupted).toBe(0);
  });

  it('«ahora» con el turno ya cortándose espera en la cola; con la mente libre, los dos envían como siempre', async () => {
    const g = gated();
    const b = await bench({ turn: g.turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });
    await b.service.interrupt(chat.id);
    const r = await b.service.submit(chat.id, { text: 'después del corte', delivery: 'now' });
    expect('queued' in r).toBe(true);
    await vi.waitFor(() => expect(thread(b, chat.id).filter(([role]) => role === 'user')).toEqual([['user', 'largo'], ['user', 'después del corte']]));
    await b.settle(chat.id);

    const libre = await b.service.submit(chat.id, { text: 'libre', delivery: 'after-turn' });
    expect('message' in libre && libre.message.text).toBe('libre');
    await b.settle(chat.id);
    expect(b.service.get(chat.id).queued).toBeUndefined();
  });

  it('si el SDK aún tiene envíos por contestar (queued_turn_count), la cola espera a ese turno: el hilo queda en orden', async () => {
    const g = gated(1);
    const b = await bench({ turn: g.turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });
    await b.service.submit(chat.id, { text: 'ahora', delivery: 'now' });
    await b.service.submit(chat.id, { text: 'luego', delivery: 'after-turn' });

    g.release();
    await vi.waitFor(() =>
      expect(thread(b, chat.id)).toEqual([
        ['user', 'largo'],
        ['user', 'ahora'],
        ['assistant', 'listo'],
        ['assistant', `eco: ${MID_TURN_NOTE}\nahora`],
        ['user', 'luego'],
        ['assistant', 'eco: luego'],
      ]),
    );
    await b.settle(chat.id);
  });

  it('un mensaje en cola que no se puede enviar avisa y no frena al siguiente', async () => {
    const g = gated();
    // Justo al terminar el turno, una sola mirada al saldo lo ve agotado: «uno» falla y «dos» sale.
    let dry = false;
    const b = await bench({
      turn: g.turn,
      budgetLeftUsd: () => {
        if (!dry) return 1;
        dry = false;
        return 0;
      },
    });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });
    await b.service.submit(chat.id, { text: 'uno', delivery: 'after-turn' });
    await b.service.submit(chat.id, { text: 'dos', delivery: 'after-turn' });
    const errors: string[] = [];
    b.hub.subscribe((m) => {
      if (m.type === 'chat_message' && m.message.text === 'listo') dry = true;
      if (m.type === 'event' && m.event.type === 'error') errors.push(m.event.payload.message);
    });
    g.release();
    await vi.waitFor(() => expect(thread(b, chat.id).filter(([role]) => role === 'user')).toEqual([['user', 'largo'], ['user', 'dos']]));
    await b.settle(chat.id);
    expect(errors.some((e) => /mensaje en cola/.test(e))).toBe(true);
    expect(b.service.get(chat.id).queued).toBeUndefined();
  });

  it('apagar el núcleo descarta la cola', async () => {
    const g = gated();
    const b = await bench({ turn: g.turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });
    await b.service.submit(chat.id, { text: 'en cola', delivery: 'after-turn' });
    b.service.shutdown();
    expect(b.service.get(chat.id).queued).toBeUndefined();
    await vi.waitFor(() => expect(thread(b, chat.id)).toContainEqual(['assistant', 'listo']));
    expect(b.q.received).toHaveLength(1);
  });

  it('cerrar el chat descarta la cola', async () => {
    const g = gated();
    const b = await bench({ turn: g.turn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });
    await b.service.submit(chat.id, { text: 'en cola', delivery: 'after-turn' });
    expect(b.service.close(chat.id).queued).toBeUndefined();
    // El turno cortado termina con lo que alcanzó a responder; lo que esperaba en la cola no se envía.
    await vi.waitFor(() => expect(thread(b, chat.id)).toEqual([['user', 'largo'], ['assistant', 'listo']]));
    await b.settle(chat.id);
    expect(b.service.get(chat.id).state).toBe('closed');
    expect(b.q.received).toHaveLength(1);
  });
});
