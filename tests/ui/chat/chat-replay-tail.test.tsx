// @vitest-environment happy-dom
/**
 * ui-chat-05: al abrir un chat se pide por /ws solo la cola de la sesión (los últimos `MAX_SESSION_EVENTS`), no toda
 * la historia desde -1, y cada página con `hasMore` se encadena una sola vez.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { lastComposerProps } from './fake-composer.tsx';
import { resetFakeLive } from './fake-live.ts';
import { at, ev, fakeCore, makeChat, makeMessage, setupApp, type Reply } from './helpers.ts';

const session = (lastSeq: number) => ({
  session: { id: 'sess_chat_1', agentId: 'claude', taskId: null, parentSessionId: null, state: 'running', startedAt: at(0), updatedAt: at(1), endedAt: null, lastSeq },
});

function openChat(sessionReply: Reply): void {
  const chat = makeChat();
  fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa', at: at(1) })] } }, (method, path) =>
    method === 'GET' && path === '/sessions/sess_chat_1' ? sessionReply : undefined,
  );
  render(<ChatView projectId="demo" chatId={chat.id} />);
}

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

describe('replay al abrir un chat', () => {
  it('pide solo la cola de la sesión, no toda la historia desde -1', async () => {
    const live = resetFakeLive();
    openChat({ body: session(3000) });
    await screen.findByText('Revisa');
    await waitFor(() => expect(live.replay).toHaveBeenCalled());
    expect(live.replay.mock.calls[0]?.slice(0, 2)).toEqual(['sess_chat_1', 2500]);
    expect(live.replay.mock.calls.some(([, since]) => since === -1)).toBe(false);
  });

  it('sin sesión todavía (404), pide desde -1', async () => {
    const live = resetFakeLive();
    openChat({ status: 404, body: { error: { code: 'not_found', message: 'No existe la sesión' } } });
    await screen.findByText('Revisa');
    await waitFor(() => expect(live.replay).toHaveBeenCalled());
    expect(live.replay.mock.calls[0]?.slice(0, 2)).toEqual(['sess_chat_1', -1]);
  });

  it('una página repetida con hasMore no arranca otra cadena', async () => {
    const live = resetFakeLive();
    openChat({ status: 404, body: { error: { code: 'not_found', message: 'No existe la sesión' } } });
    await screen.findByText('Revisa');
    await waitFor(() => expect(live.replay).toHaveBeenCalledWith('sess_chat_1', -1));
    const page = { type: 'replay' as const, sessionId: 'sess_chat_1', events: [ev.text(2998, 2, 'a'), ev.text(2999, 2, 'b')], lastSeq: 2999, hasMore: true };

    act(() => {
      live.emit(page);
      live.emit(page);
    });

    expect(live.replay.mock.calls.filter(([, since]) => since === 2999)).toHaveLength(1);
  });
});
