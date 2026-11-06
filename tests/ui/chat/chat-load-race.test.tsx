// @vitest-environment happy-dom
/**
 * ui-chat-02: la carga REST de un chat no pisa lo que llegó por /ws mientras estaba en vuelo, y «Detener» aplica
 * el chat que devuelve el núcleo (sin volver a un `running` más viejo).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ui/api/live.ts', async () => {
  const m = await import('./fake-live.ts');
  return { getLive: () => m.getFakeLive() };
});
vi.mock('../../../src/ui/features/composer/Composer.tsx', async () => {
  const m = await import('./fake-composer.tsx');
  return { Composer: m.FakeComposer };
});

import ChatView from '../../../src/ui/features/chat/ChatView.tsx';
import { useChat } from '../../../src/ui/features/chat/store.ts';
import { lastComposerProps } from './fake-composer.tsx';
import { resetFakeLive } from './fake-live.ts';
import { at, fakeCore, makeChat, makeMessage, setupApp, type Call } from './helpers.ts';

/** Retiene las respuestas a `method path` (tomadas en el momento de la petición) hasta `release()`. */
function hold(method: string, path: string): { release(): void } {
  const inner = globalThis.fetch;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if ((init?.method ?? 'GET') === method && new URL(href).pathname === path) await gate;
    return res;
  });
  return { release: () => release() };
}

const requested = (calls: Call[], method: string, path: string) => calls.some((c) => c.method === method && c.path === path);

beforeEach(() => {
  setupApp();
  resetFakeLive();
  lastComposerProps.current = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('carga del chat y /ws', () => {
  it('la foto REST vieja no pisa el fin de turno que llegó por /ws durante la carga', async () => {
    const live = resetFakeLive();
    const chat = makeChat({ state: 'running', updatedAt: at(1) });
    const { calls } = fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa', at: at(1) })] } });
    const get = hold('GET', '/chats/chat_abc123');

    render(<ChatView projectId="demo" chatId="chat_abc123" />);
    await waitFor(() => expect(requested(calls, 'GET', '/chats/chat_abc123/messages')).toBe(true));
    act(() => {
      live.emit({ type: 'chat_message', message: makeMessage({ id: 'm2', role: 'assistant', text: 'Respuesta lista', at: at(9) }) });
      live.emit({ type: 'chat', chat: { ...chat, state: 'idle', updatedAt: at(10) } });
    });
    act(() => get.release());

    await waitFor(() => expect(useChat.getState().status).toBe('ready'));
    expect(await screen.findByText('Respuesta lista')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar respuesta' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Detener' })).toBeNull();
    expect(lastComposerProps.current?.isStreaming).toBe(false);
    expect(useChat.getState().chats.find((c) => c.id === chat.id)?.state).toBe('idle');
  });

  it('«Detener» aplica el chat que devuelve el núcleo cuando no hay turno que cortar', async () => {
    const chat = makeChat({ state: 'running', updatedAt: at(1) });
    fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa', at: at(1) })] } }, (method, path) =>
      method === 'POST' && path === '/chats/chat_abc123/interrupt' ? { body: { chat: { ...chat, state: 'idle', updatedAt: at(10) } } } : undefined,
    );
    render(<ChatView projectId="demo" />);
    await screen.findByText('Revisa');

    fireEvent.click(screen.getByRole('button', { name: 'Detener' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Detener' })).toBeNull());
    expect(useChat.getState().chat?.state).toBe('idle');
  });

  it('una respuesta de «Detener» más vieja que el chat de /ws no lo devuelve a running', async () => {
    const live = resetFakeLive();
    const chat = makeChat({ state: 'running', updatedAt: at(1) });
    fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa', at: at(1) })] } }, (method, path) =>
      method === 'POST' && path === '/chats/chat_abc123/interrupt' ? { body: { chat: { ...chat, state: 'running', updatedAt: at(5) } } } : undefined,
    );
    render(<ChatView projectId="demo" />);
    await screen.findByText('Revisa');
    const stop = hold('POST', '/chats/chat_abc123/interrupt');

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = useChat.getState().interrupt();
    });
    act(() => live.emit({ type: 'chat', chat: { ...chat, state: 'idle', updatedAt: at(10) } }));
    stop.release();
    await act(async () => done);

    expect(useChat.getState().chat?.state).toBe('idle');
    expect(screen.queryByRole('button', { name: 'Detener' })).toBeNull();
  });
});
