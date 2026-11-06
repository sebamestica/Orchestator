// @vitest-environment happy-dom
/**
 * Enviar mientras la mente razona (ui-chat-08): con un turno en curso el Composer pregunta cuándo entregar el mensaje
 * («Ahora», «Al terminar», «Más tarde»); la cola del chat se ve en el hilo y los pendientes, sobre el Composer.
 * Usa el Composer de verdad.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ui/api/live.ts', async () => {
  const m = await import('./fake-live.ts');
  return { getLive: () => m.getFakeLive() };
});

import type { Chat } from '../../../src/shared/index.ts';
import ChatView from '../../../src/ui/features/chat/ChatView.tsx';
import { useChat } from '../../../src/ui/features/chat/store.ts';
import { resetFakeLive } from './fake-live.ts';
import { at, fakeCore, makeChat, makeMessage, setupApp, type Call } from './helpers.ts';

const CHAT = 'chat_abc123';

beforeEach(() => {
  setupApp();
  useChat.setState({ later: {} });
  resetFakeLive();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.path === `/chats/${CHAT}/messages`).map((c) => c.body);
const stops = (calls: Call[]) => calls.filter((c) => c.path === `/chats/${CHAT}/interrupt`);

function working(over: Partial<Chat> = {}) {
  const chat = makeChat({ state: 'running', ...over });
  const state = { chats: [chat], messages: { [CHAT]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa el módulo', at: at(1) })] } };
  return state;
}

/** Abre el chat, espera a que el Composer esté listo y escribe `text` en el campo. */
async function writeMessage(text: string) {
  render(<ChatView projectId="demo" chatId={CHAT} />);
  await screen.findByText('Revisa el módulo');
  const box = screen.getByLabelText('Mensaje') as HTMLTextAreaElement;
  await waitFor(() => expect(box.disabled).toBe(false));
  fireEvent.change(box, { target: { value: text } });
  return box;
}

const choice = () => screen.queryByRole('group', { name: '¿Cuándo lo envío?' });
const option = (name: string) => within(screen.getByRole('group', { name: '¿Cuándo lo envío?' })).getByRole('button', { name });

describe('elegir cuándo entregar', () => {
  it('con la mente trabajando, Enter pregunta en vez de enviar', async () => {
    const { calls } = fakeCore(working());
    const box = await writeMessage('y revisa también los tests');

    fireEvent.keyDown(box, { key: 'Enter' });

    expect(choice()).toBeTruthy();
    for (const name of ['Ahora', 'Al terminar', 'Más tarde', 'Cancelar']) expect(option(name)).toBeTruthy();
    expect(posts(calls)).toEqual([]);
    // El botón de enviar convive con el de detener.
    expect(screen.getByRole('button', { name: 'Enviar mensaje' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Detener respuesta' })).toBeTruthy();
  });

  it('«Ahora» manda el mensaje con delivery now y limpia el campo', async () => {
    const { calls } = fakeCore(working());
    const box = await writeMessage('y revisa también los tests');
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.click(option('Ahora'));

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ text: 'y revisa también los tests', delivery: 'now' });
    await waitFor(() => expect(box.value).toBe(''));
    expect(choice()).toBeNull();
    // Entró al turno: aparece en el hilo, no en la cola.
    expect(await screen.findByText('y revisa también los tests')).toBeTruthy();
    expect(screen.queryByText('En cola')).toBeNull();
  });

  it('«Al terminar» manda delivery after-turn y el mensaje queda «En cola», fuera del hilo', async () => {
    const { calls } = fakeCore(working());
    const box = await writeMessage('luego actualiza el README');
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.click(option('Al terminar'));

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ text: 'luego actualiza el README', delivery: 'after-turn' });
    await waitFor(() => expect(box.value).toBe(''));
    expect(await screen.findByText('En cola')).toBeTruthy();
    expect(screen.getByText('luego actualiza el README')).toBeTruthy();
    expect(screen.getAllByTestId('user-message')).toHaveLength(1);
    expect(useChat.getState().messages).toHaveLength(1);
    expect(useChat.getState().chat?.state).toBe('running');
    expect(useChat.getState().chat?.queued?.map((q) => q.text)).toEqual(['luego actualiza el README']);
  });

  it('Escape cierra la elección sin detener el turno; sin elección abierta, sí lo detiene', async () => {
    const { calls } = fakeCore(working());
    const box = await writeMessage('algo más');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(choice()).toBeTruthy();

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(choice()).toBeNull();
    expect(stops(calls)).toEqual([]);
    expect(posts(calls)).toEqual([]);
    expect(box.value).toBe('algo más');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(stops(calls)).toHaveLength(1));
  });

  it('«Cancelar» cierra la elección y conserva el texto', async () => {
    const { calls } = fakeCore(working());
    const box = await writeMessage('mejor no');
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.click(option('Cancelar'));

    expect(choice()).toBeNull();
    expect(box.value).toBe('mejor no');
    expect(posts(calls)).toEqual([]);
  });

  it('con la mente libre, Enter envía directo, sin elección y sin delivery', async () => {
    const { calls } = fakeCore({ chats: [makeChat()], messages: { [CHAT]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa el módulo', at: at(1) })] } });
    const box = await writeMessage('hola de nuevo');

    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(choice()).toBeNull();
    expect(posts(calls)[0]).not.toHaveProperty('delivery');
    expect(posts(calls)[0]).toMatchObject({ text: 'hola de nuevo' });
  });

  it('sin turno y con subagentes en segundo plano, Enter también envía directo (el núcleo no espera a nadie)', async () => {
    const { calls } = fakeCore({ chats: [makeChat({ backgroundTasks: 2 })], messages: { [CHAT]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa el módulo', at: at(1) })] } });
    const box = await writeMessage('mientras tanto');

    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(choice()).toBeNull();
    expect(posts(calls)[0]).not.toHaveProperty('delivery');
  });
});

describe('cola del chat', () => {
  const queued = { id: 'queued_1', text: 'y revisa también los tests', attachments: [], at: at(30) };

  it('un chat con `queued` los muestra «En cola» y «Quitar de la cola» llama a DELETE', async () => {
    const { calls } = fakeCore(working({ queued: [queued] }));
    render(<ChatView projectId="demo" chatId={CHAT} />);

    expect(await screen.findByText('y revisa también los tests')).toBeTruthy();
    expect(screen.getByText('En cola')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Quitar de la cola' }));

    await waitFor(() => expect(screen.queryByText('y revisa también los tests')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/chats/${CHAT}/queue/queued_1`]);
    expect(screen.queryByText('En cola')).toBeNull();
    expect(useChat.getState().chat?.queued).toEqual([]);
  });

  it('si no se pudo quitar, avisa y la cola sigue', async () => {
    fakeCore(working({ queued: [queued] }), (method) =>
      method === 'DELETE' ? { status: 404, body: { error: { code: 'not_found', message: 'El mensaje ya no está en la cola' } } } : undefined,
    );
    render(<ChatView projectId="demo" chatId={CHAT} />);
    await screen.findByText('En cola');

    fireEvent.click(screen.getByRole('button', { name: 'Quitar de la cola' }));

    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo quitar de la cola: El mensaje ya no está en la cola');
    expect(screen.getByText('En cola')).toBeTruthy();
  });

  it('la cola que llega por /ws se ve sin recargar', async () => {
    const live = resetFakeLive();
    fakeCore(working());
    render(<ChatView projectId="demo" chatId={CHAT} />);
    await screen.findByText('Revisa el módulo');
    expect(screen.queryByText('En cola')).toBeNull();

    act(() => live.emit({ type: 'chat', chat: makeChat({ state: 'running', queued: [queued] }) }));

    expect(await screen.findByText('En cola')).toBeTruthy();
  });
});

describe('«Más tarde»', () => {
  async function saveForLater(text: string) {
    const box = await writeMessage(text);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(option('Más tarde'));
    await screen.findByText('Pendiente');
    await waitFor(() => expect(box.value).toBe(''));
    return box;
  }

  it('guarda el pendiente sobre el Composer sin ningún POST y vacía el campo', async () => {
    const { calls } = fakeCore(working());
    const box = await saveForLater('acuérdate de los logs');

    expect(screen.getByText('acuérdate de los logs')).toBeTruthy();
    expect(box.value).toBe('');
    expect(choice()).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(useChat.getState().later[CHAT]?.map((m) => m.text)).toEqual(['acuérdate de los logs']);
  });

  it('«Enviar pendiente» lo manda con delivery now si el chat sigue en running y lo quita', async () => {
    const { calls } = fakeCore(working());
    await saveForLater('acuérdate de los logs');

    fireEvent.click(screen.getByRole('button', { name: 'Enviar pendiente' }));

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ text: 'acuérdate de los logs', delivery: 'now' });
    await waitFor(() => expect(screen.queryByText('Pendiente')).toBeNull());
    expect(useChat.getState().later[CHAT]).toEqual([]);
  });

  it('«Enviar pendiente» con la mente libre lo manda sin delivery', async () => {
    const { calls, state } = fakeCore(working());
    await saveForLater('acuérdate de los logs');
    // El turno termina: llega el chat libre por /ws.
    act(() => useChat.getState().applyLive({ type: 'chat', chat: { ...(state.chats[0] ?? makeChat()), state: 'idle' } }));
    await waitFor(() => expect(useChat.getState().chat?.state).toBe('idle'));

    fireEvent.click(screen.getByRole('button', { name: 'Enviar pendiente' }));

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).not.toHaveProperty('delivery');
    await waitFor(() => expect(screen.queryByText('Pendiente')).toBeNull());
  });

  it('«Borrar pendiente» lo quita sin POST', async () => {
    const { calls } = fakeCore(working());
    await saveForLater('acuérdate de los logs');

    fireEvent.click(screen.getByRole('button', { name: 'Borrar pendiente' }));

    await waitFor(() => expect(screen.queryByText('Pendiente')).toBeNull());
    expect(screen.queryByText('acuérdate de los logs')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('los pendientes siguen ahí al cambiar de chat y volver', async () => {
    const other = makeChat({ id: 'chat_otro01', title: 'Otra', sessionId: 'sess_chat_2', updatedAt: at(-5) });
    fakeCore({ ...working(), chats: [makeChat({ state: 'running' }), other] });
    await saveForLater('acuérdate de los logs');

    await act(async () => { await useChat.getState().select('chat_otro01'); });
    await waitFor(() => expect(useChat.getState().chat?.id).toBe('chat_otro01'));
    expect(screen.queryByText('Pendiente')).toBeNull();

    await act(async () => { await useChat.getState().select(CHAT); });
    expect(await screen.findByText('acuérdate de los logs')).toBeTruthy();
  });
});
