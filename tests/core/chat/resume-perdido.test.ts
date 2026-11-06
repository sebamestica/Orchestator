/**
 * La transcripción del SDK de un chat ya no existe (issue mente-04): el SDK lo dice por stderr, entrega un `result`
 * `error_during_execution` con «No conversation found with session ID» y lanza. El chat olvida ese id, avisa y
 * reintenta el turno una vez sin `resume`, en vez de quedar roto.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bench, closeBenches, echoTurn, sdkErrorExit, sdkLostResume, tick, type ChatBench, type TurnContext, type TurnFn, type TurnOutput } from './helpers.ts';

afterEach(closeBenches);

type Failure = (ctx: TurnContext) => TurnOutput[];

/** Lo que hace el SDK real cuando ya no tiene la transcripción de `sdk-1`. */
const LOST: Failure = (ctx) => sdkLostResume('sdk-1', ctx);

/** `echoTurn`, salvo al reanudar `sdk-1`: ahí el proceso del SDK falla con `failure`. */
const failingResume = (failure: Failure): TurnFn => (message, ctx) => (ctx.options.resume === 'sdk-1' ? failure(ctx) : echoTurn(message, ctx));

async function turn(b: ChatBench, chatId: string, text: string): Promise<void> {
  await b.service.send(chatId, { text });
  await b.settle(chatId);
}

/** Primer turno (guarda `sdk-1`) y cierre de la sesión ociosa: el mensaje siguiente reanuda con `resume`. */
async function resumable(failure: Failure) {
  const b = await bench({ idleMs: 50, turn: failingResume(failure) });
  const chat = b.service.create({ projectId: 'demo' });
  await turn(b, chat.id, 'uno');
  for (let i = 0; i < 200 && b.q.closed === 0; i++) await tick(10);
  expect(b.q.closed).toBe(1);
  return { b, chat };
}

const storedSdkId = (b: ChatBench, chatId: string) =>
  (b.store.database.prepare('SELECT sdk_session_id AS id FROM chat_chats WHERE id = ?').get(chatId) as { id: string | null }).id;

describe('ChatService: reanudar una sesión del SDK que ya no existe', () => {
  it('olvida el id, avisa y responde en el mismo turno con una sesión nueva', async () => {
    const { b, chat } = await resumable(LOST);
    await turn(b, chat.id, 'dos');

    expect(b.q.calls[1]?.options.resume).toBe('sdk-1');
    expect(b.q.calls).toHaveLength(3);
    expect(b.q.calls[2]?.options.resume).toBeUndefined();
    const notice = b.events(chat.sessionId).find((e) => e.type === 'status' && /No se pudo reanudar/.test(e.payload.detail ?? ''));
    expect(notice).toBeDefined();
    expect(b.events(chat.sessionId).some((e) => e.type === 'error')).toBe(false);
    expect(storedSdkId(b, chat.id)).toBe('sdk-3');
    expect(b.service.get(chat.id).state).toBe('idle');
    expect(b.service.messages(chat.id).map((m) => m.text)).toEqual(['uno', 'eco: uno', 'dos', 'eco: dos']);

    // El mensaje siguiente sigue en la sesión nueva, sin volver a pedir la vieja.
    await turn(b, chat.id, 'tres');
    expect(b.q.calls.slice(2).map((c) => c.options.resume)).not.toContain('sdk-1');
    expect(b.service.get(chat.id).state).toBe('idle');
  });

  it('cerrar el chat mientras se repite el turno no lo deja colgado', async () => {
    let chatId = '';
    let armed = false;
    const b = await bench({
      idleMs: 50,
      turn: (message, ctx) => {
        if (ctx.options.resume === 'sdk-1') armed = true;
        return failingResume(LOST)(message, ctx);
      },
      // Se lee al empezar a recrear la sesión: el chat se cierra justo durante el reintento.
      mcpServersFor: () => {
        if (armed) {
          armed = false;
          b.service.close(chatId);
        }
        return {};
      },
    });
    const chat = b.service.create({ projectId: 'demo' });
    chatId = chat.id;
    await turn(b, chat.id, 'uno');
    for (let i = 0; i < 200 && b.q.closed === 0; i++) await tick(10);
    await b.service.send(chat.id, { text: 'dos' });
    // La sesión que falló al reanudar se cierra al terminar su lectura (uso-real-05); la que abrió el reintento,
    // al cerrarse el chat, y el turno termina.
    for (let i = 0; i < 200 && b.q.closed < 3; i++) await tick(10);
    expect(b.q.closed).toBe(3);
    expect(b.service.get(chat.id).state).toBe('closed');

    // El chat no quedó ocupado: el mensaje siguiente lo reabre y responde.
    await turn(b, chat.id, 'tres');
    expect(b.service.get(chat.id).state).toBe('idle');
    expect(b.service.messages(chat.id).at(-1)?.text).toBe('eco: tres');
  });

  it('otro error al reanudar (p. ej. falta el ejecutable) no borra el id ni reintenta', async () => {
    const { b, chat } = await resumable(() => [new Error('spawn ENOENT')]);
    await turn(b, chat.id, 'dos');

    expect(b.q.calls).toHaveLength(2);
    expect(storedSdkId(b, chat.id)).toBe('sdk-1');
    expect(b.service.get(chat.id).state).toBe('error');
  });

  it('un resultado de error al reanudar que no es la transcripción perdida no borra el id ni reintenta', async () => {
    const { b, chat } = await resumable((ctx) => sdkErrorExit('sdk-1', 'API Error: 500 Internal Server Error', ctx));
    await turn(b, chat.id, 'dos');

    expect(b.q.calls).toHaveLength(2);
    expect(storedSdkId(b, chat.id)).toBe('sdk-1');
    expect(b.service.get(chat.id).state).toBe('error');
    expect(b.events(chat.sessionId).some((e) => e.type === 'status' && /No se pudo reanudar/.test(e.payload.detail ?? ''))).toBe(false);
  });
});
