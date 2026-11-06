/**
 * La transcripción del SDK de un chat ya no existe (issue mente-04): el CLI sale con «No conversation found with
 * session ID». El chat olvida ese id, avisa y reintenta el turno una vez sin `resume`, en vez de quedar roto.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bench, closeBenches, echoTurn, tick, type ChatBench, type TurnFn } from './helpers.ts';

afterEach(closeBenches);

const LOST = 'Claude Code process exited with code 1\nNo conversation found with session ID: sdk-1';

/** `echoTurn`, salvo al reanudar `sdk-1`: ahí el proceso del SDK muere con `failure`. */
const failingResume = (failure: string): TurnFn => (message, ctx) => {
  if (ctx.options.resume === 'sdk-1') throw new Error(failure);
  return echoTurn(message, ctx);
};

async function turn(b: ChatBench, chatId: string, text: string): Promise<void> {
  await b.service.send(chatId, { text });
  await b.settle(chatId);
}

/** Primer turno (guarda `sdk-1`) y cierre de la sesión ociosa: el mensaje siguiente reanuda con `resume`. */
async function resumable(failure: string) {
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
    const { b, chat } = await resumable('spawn ENOENT');
    await turn(b, chat.id, 'dos');

    expect(b.q.calls).toHaveLength(2);
    expect(storedSdkId(b, chat.id)).toBe('sdk-1');
    expect(b.service.get(chat.id).state).toBe('error');
  });
});
