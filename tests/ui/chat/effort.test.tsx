// @vitest-environment happy-dom
/**
 * Esfuerzo de razonamiento por chat (issue 10): viaja en `POST /chats/:id/messages`, se recuerda por chat en el store
 * con respaldo en `localStorage` y, sin elección, vale el de Ajustes.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effortSchema } from '../../../src/shared/api.ts';

vi.mock('../../../src/ui/api/live.ts', async () => {
  const m = await import('./fake-live.ts');
  return { getLive: () => m.getFakeLive() };
});
vi.mock('../../../src/ui/features/composer/Composer.tsx', async () => {
  const m = await import('./fake-composer.tsx');
  return { Composer: m.FakeComposer };
});

import ChatView from '../../../src/ui/features/chat/ChatView.tsx';
import { EFFORT_STORAGE_KEY, MAX_REMEMBERED_EFFORTS, chosenEffort, effortIn, readEfforts, useChat } from '../../../src/ui/features/chat/store.ts';
import { useApp } from '../../../src/ui/store/app.ts';
import { lastComposerProps } from './fake-composer.tsx';
import { resetFakeLive } from './fake-live.ts';
import { fakeCore, makeChat, setupApp, type Call } from './helpers.ts';

function composer() {
  const props = lastComposerProps.current;
  if (!props) throw new Error('El Composer no se montó');
  return props;
}

const sent = (calls: Call[], chatId: string) => calls.filter((c) => c.method === 'POST' && c.path === `/chats/${chatId}/messages`).map((c) => c.body);
const stored = () => JSON.parse(localStorage.getItem(EFFORT_STORAGE_KEY) ?? '{}') as unknown;

async function ready(chatId: string | null) {
  await waitFor(() => expect(composer().isDisabled).toBe(false));
  if (chatId) await waitFor(() => expect(useChat.getState().chat?.id).toBe(chatId));
}

async function submit(text: string) {
  await act(async () => {
    await composer().onSubmit({ text, attachments: [] });
  });
}

beforeEach(() => {
  localStorage.clear();
  setupApp();
  resetFakeLive();
  lastComposerProps.current = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('esfuerzo en el mensaje', () => {
  it('sin elección manda el de Ajustes; lo elegido viaja como `effort` en el cuerpo y queda en el respaldo', async () => {
    const { calls } = fakeCore({ chats: [makeChat()] });
    render(<ChatView projectId="demo" />);
    await ready('chat_abc123');

    expect(composer().effort).toBe('medium');
    expect(composer().effortLevels).toEqual(effortSchema.options);
    expect(screen.getByTestId('composer').dataset.effort).toBe('medium');
    await submit('Primero');

    act(() => composer().onEffortChange?.('low'));
    expect(composer().effort).toBe('low');
    await submit('¿Qué hora es en Santiago?');

    expect(sent(calls, 'chat_abc123')).toEqual([
      { text: 'Primero', attachmentIds: [], effort: 'medium' },
      { text: '¿Qué hora es en Santiago?', attachmentIds: [], effort: 'low' },
    ]);
    expect(stored()).toEqual({ chat_abc123: 'low' });
  });

  it('el de Ajustes rige mientras el chat no tenga uno propio', async () => {
    useApp.setState((s) => ({ settings: { ...s.settings, mind: { ...s.settings.mind, effort: 'medium' } } }));
    const { calls } = fakeCore({ chats: [makeChat()] });
    render(<ChatView projectId="demo" />);
    await ready('chat_abc123');
    await submit('Hola');
    expect(sent(calls, 'chat_abc123')).toEqual([{ text: 'Hola', attachmentIds: [], effort: 'medium' }]);
    expect(localStorage.getItem(EFFORT_STORAGE_KEY)).toBeNull();
  });
});

describe('recuerdo por chat', () => {
  it('cada conversación conserva su esfuerzo al ir y volver', async () => {
    const a = makeChat({ id: 'chat_aaa111', title: 'Alfa', sessionId: 'sess_a', updatedAt: '2026-11-04T12:00:02.000Z' });
    const b = makeChat({ id: 'chat_bbb222', title: 'Beta', sessionId: 'sess_b', updatedAt: '2026-11-04T12:00:01.000Z' });
    const { calls } = fakeCore({ chats: [a, b] });
    const view = render(<ChatView projectId="demo" chatId="chat_aaa111" />);
    await ready('chat_aaa111');
    act(() => composer().onEffortChange?.('low'));

    view.rerender(<ChatView projectId="demo" chatId="chat_bbb222" />);
    await ready('chat_bbb222');
    expect(composer().effort).toBe('medium');
    act(() => composer().onEffortChange?.('max'));
    await submit('Piensa a fondo');

    view.rerender(<ChatView projectId="demo" chatId="chat_aaa111" />);
    await ready('chat_aaa111');
    expect(composer().effort).toBe('low');
    await submit('Rápido');

    expect(sent(calls, 'chat_bbb222')).toEqual([{ text: 'Piensa a fondo', attachmentIds: [], effort: 'max' }]);
    expect(sent(calls, 'chat_aaa111')).toEqual([{ text: 'Rápido', attachmentIds: [], effort: 'low' }]);
    expect(stored()).toEqual({ chat_aaa111: 'low', chat_bbb222: 'max' });
  });

  it('sobrevive a recargar: al abrir lee el respaldo de localStorage', async () => {
    localStorage.setItem(EFFORT_STORAGE_KEY, JSON.stringify({ chat_abc123: 'xhigh', chat_otro999: 'turbo', 'no válido': 'low' }));
    useChat.getState().reset();
    expect(useChat.getState().efforts).toEqual({ chat_abc123: 'xhigh' });
    const { calls } = fakeCore({ chats: [makeChat()] });
    render(<ChatView projectId="demo" />);
    await ready('chat_abc123');
    expect(composer().effort).toBe('xhigh');
    await submit('Sigue');
    expect(sent(calls, 'chat_abc123')).toEqual([{ text: 'Sigue', attachmentIds: [], effort: 'xhigh' }]);
  });

  it('lo elegido antes de crear el chat pasa al chat nuevo', async () => {
    const { calls } = fakeCore({ chats: [] });
    render(<ChatView projectId="demo" />);
    await ready(null);
    act(() => composer().onEffortChange?.('low'));
    expect(composer().effort).toBe('low');
    expect(useChat.getState().draftEffort).toBe('low');

    await submit('Dime ya cuántos tests hay');
    await waitFor(() => expect(window.location.hash).toBe('#/p/demo/c/chat_new001'));
    expect(sent(calls, 'chat_new001')).toEqual([{ text: 'Dime ya cuántos tests hay', attachmentIds: [], effort: 'low' }]);
    expect(useChat.getState().draftEffort).toBeNull();
    expect(stored()).toEqual({ chat_new001: 'low' });
    expect(composer().effort).toBe('low');
  });

  it('borrar el chat, o que llegue `chat_deleted`, olvida su esfuerzo', async () => {
    const a = makeChat({ id: 'chat_aaa111', sessionId: 'sess_a' });
    const b = makeChat({ id: 'chat_bbb222', sessionId: 'sess_b' });
    fakeCore({ chats: [a, b] });
    localStorage.setItem(EFFORT_STORAGE_KEY, JSON.stringify({ chat_aaa111: 'low', chat_bbb222: 'max', chat_ccc333: 'medium' }));
    useChat.getState().reset();
    await useChat.getState().open('demo', 'chat_aaa111', 'plan');

    await useChat.getState().deleteChat('chat_aaa111');
    expect(stored()).toEqual({ chat_bbb222: 'max', chat_ccc333: 'medium' });
    useChat.getState().applyLive({ type: 'chat_deleted', chatId: 'chat_ccc333' });
    expect(useChat.getState().efforts).toEqual({ chat_bbb222: 'max' });
    expect(stored()).toEqual({ chat_bbb222: 'max' });
  });
});

describe('respaldo en localStorage', () => {
  it('JSON dañado o almacenamiento que falla: el esfuerzo queda en memoria y nada se rompe', async () => {
    localStorage.setItem(EFFORT_STORAGE_KEY, '{esto no es json');
    expect(readEfforts()).toEqual({});
    localStorage.setItem(EFFORT_STORAGE_KEY, '["low"]');
    expect(readEfforts()).toEqual({});

    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem,
    });
    expect(readEfforts()).toEqual({});
    fakeCore({ chats: [makeChat()] });
    useChat.getState().reset();
    await useChat.getState().open('demo', null, 'plan');
    useChat.getState().setEffort('max');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(chosenEffort(useChat.getState())).toBe('max');
  });

  it(`recuerda como máximo ${MAX_REMEMBERED_EFFORTS} chats y olvida los más antiguos`, () => {
    const many = Object.fromEntries(Array.from({ length: MAX_REMEMBERED_EFFORTS + 5 }, (_, i) => [`chat_${String(i).padStart(4, '0')}`, 'low']));
    localStorage.setItem(EFFORT_STORAGE_KEY, JSON.stringify(many));
    const efforts = readEfforts();
    expect(Object.keys(efforts)).toHaveLength(MAX_REMEMBERED_EFFORTS);
    expect(efforts.chat_0004).toBeUndefined();
    expect(efforts.chat_0005).toBe('low');
  });

  it('un id no lee propiedades heredadas del objeto', () => {
    expect(effortIn({}, 'constructor')).toBeNull();
    expect(effortIn(Object.fromEntries([['toString', 'low' as const]]), 'toString')).toBe('low');
  });
});
