// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../../src/shared/api.ts';

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
import { at, ev, fakeCore, installFetch, makeAttachment, makeChat, makeMessage, makeProposal, setupApp, type Call } from './helpers.ts';

function composer() {
  const props = lastComposerProps.current;
  if (!props) throw new Error('El Composer no se montó');
  return props;
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => c.path);
const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

function setBridge(bridge: Partial<DesktopBridge> | undefined) {
  if (bridge) window.orq = bridge as DesktopBridge;
  else delete window.orq;
}

beforeEach(() => {
  setupApp();
  resetFakeLive();
  lastComposerProps.current = null;
});

afterEach(() => {
  cleanup();
  setBridge(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mensajes', () => {
  it('muestra la burbuja del usuario con su imagen y la respuesta de la mente en Markdown', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:miniatura');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const chat = makeChat();
    const md = '## Estado\n\nTodo **bien**.\n\n- uno\n- dos\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const { calls } = fakeCore(
      {
        chats: [chat],
        messages: {
          [chat.id]: [
            makeMessage({ id: 'm1', role: 'user', text: 'Hola mente', at: at(1), attachments: [makeAttachment()] }),
            makeMessage({ id: 'm2', role: 'assistant', text: md, at: at(9) }),
          ],
        },
      },
      (_method, path) => (path === '/attachments/att_img001' ? { raw: new Blob(['png']), contentType: 'image/png' } : undefined),
    );

    const view = render(<ChatView projectId="demo" />);

    const bubble = await screen.findByText('Hola mente');
    expect(bubble.className).toContain('rounded-2xl');
    expect(bubble.className).toContain('selectable');
    expect(screen.getByRole('heading', { name: 'Estado' })).toBeTruthy();
    expect(screen.getByText('bien').tagName).toBe('STRONG');
    expect(screen.getByText('uno').tagName).toBe('LI');
    expect(screen.getByText('const x = 1;').closest('pre')?.className).toContain('font-mono');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('Demo')).toBeTruthy();
    expect(screen.getByText('C:\\dev\\demo')).toBeTruthy();
    expect(screen.getByLabelText('Costo de esta conversación: US$0,12')).toBeTruthy();

    // Miniatura: GET /attachments/:id con el token y URL local.
    const img = await screen.findByAltText('captura.png');
    expect(img.getAttribute('src')).toBe('blob:miniatura');
    const thumb = calls.find((c) => c.path === '/attachments/att_img001');
    expect(thumb?.headers.get('Authorization')).toBe(`Bearer ${'k'.repeat(43)}`);
    expect(createUrl).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Copiar código' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
    expect(await screen.findByRole('button', { name: 'Copiado' })).toBeTruthy();

    view.unmount();
    expect(revokeUrl).toHaveBeenCalledWith('blob:miniatura');
  });
});

describe('respuesta en vivo', () => {
  it('arma texto por deltas y herramientas plegadas desde /ws, y la reemplaza al llegar chat_message', async () => {
    const live = resetFakeLive();
    const chat = makeChat({ state: 'running' });
    fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa', at: at(1) })] } });

    render(<ChatView projectId="demo" chatId="chat_abc123" />);
    await screen.findByText('Revisa');
    await waitFor(() => expect(live.replay).toHaveBeenCalledWith('sess_chat_1', -1));
    expect(screen.getByText('Pensando…')).toBeTruthy();

    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    act(() => {
      live.emit({ type: 'event', event: ev.text(0, 2, 'Hola, ') });
      live.emit({ type: 'event', event: ev.text(1, 2, 'mundo') });
      live.emit({ type: 'event', event: ev.call(2, 3, 'c1', 'mcp__orquestador__estado', 'proyecto demo') });
      live.emit({ type: 'event', event: ev.result(3, 4, 'c1', true, '3 tareas en curso') });
      live.emit({ type: 'event', event: ev.usage(4, 4, 12_300, 450, 0.04) });
      live.emit({ type: 'event', event: { ...ev.text(5, 4, 'ajeno'), sessionId: 'otra_sesion' } });
    });
    // Un solo cuadro para todo el lote.
    expect(raf).toHaveBeenCalledTimes(1);

    const reply = await screen.findByTestId('live-reply');
    await waitFor(() => expect(within(reply).getByText('Hola, mundo')).toBeTruthy());
    expect(within(reply).queryByText('ajeno')).toBeNull();
    expect(within(reply).getByLabelText('Uso de tokens').textContent).toContain('12 k de entrada');
    expect(within(reply).getByLabelText('Uso de tokens').textContent).toContain('US$0,04');

    const row = within(reply).getByRole('button', { name: /estado/ });
    expect(row.textContent).toContain('proyecto demo');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(within(reply).queryByText('3 tareas en curso')).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(within(reply).getByText('3 tareas en curso')).toBeTruthy();

    // El replay se cruza con el vivo: no duplica.
    act(() => live.emit({ type: 'replay', sessionId: 'sess_chat_1', events: [ev.text(0, 2, 'Hola, '), ev.text(1, 2, 'mundo')], lastSeq: 1, hasMore: false }));
    await waitFor(() => expect(within(screen.getByTestId('live-reply')).getAllByText('Hola, mundo')).toHaveLength(1));

    act(() => {
      live.emit({ type: 'chat_message', message: makeMessage({ id: 'm2', role: 'assistant', text: 'Hola, mundo. Listo.', at: at(6) }) });
      live.emit({ type: 'chat', chat: { ...chat, state: 'idle' } });
    });
    await waitFor(() => expect(screen.queryByTestId('live-reply')).toBeNull());
    expect(screen.getByText('Hola, mundo. Listo.')).toBeTruthy();
    expect(screen.queryByText('Pensando…')).toBeNull();
    // Los pasos del turno quedan plegados sobre la respuesta guardada.
    expect(screen.getByRole('button', { name: /1 paso/ })).toBeTruthy();
  });

  it('al reconectar pide replay desde el último seq y recarga los mensajes', async () => {
    const live = resetFakeLive();
    const chat = makeChat({ state: 'running' });
    const { calls } = fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa', at: at(1) })] } });
    render(<ChatView projectId="demo" />);
    await screen.findByText('Revisa');
    act(() => live.emit({ type: 'replay', sessionId: 'sess_chat_1', events: [ev.text(0, 2, 'a'), ev.text(1, 2, 'b')], lastSeq: 1, hasMore: true }));
    // Hay más páginas: pide la siguiente.
    expect(live.replay).toHaveBeenLastCalledWith('sess_chat_1', 1);
    await screen.findByText('ab');

    const before = calls.filter((c) => c.path === '/chats/chat_abc123/messages').length;
    act(() => {
      live.setStatus('closed');
      live.setStatus('open');
    });
    expect(live.replay).toHaveBeenLastCalledWith('sess_chat_1', 1);
    await waitFor(() => expect(calls.filter((c) => c.path === '/chats/chat_abc123/messages').length).toBe(before + 1));
  });

  it('detener llama a interrupt', async () => {
    const chat = makeChat({ state: 'running' });
    const { calls } = fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Revisa', at: at(1) })] } });
    render(<ChatView projectId="demo" />);
    await screen.findByText('Revisa');
    expect(screen.getByTestId('composer').dataset.streaming).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Detener' }));
    await waitFor(() => expect(posts(calls)).toContain('/chats/chat_abc123/interrupt'));
  });
});

describe('modo de la mente', () => {
  it('Shift+Tab fuera de un campo de texto cicla auto → plan → bypass → auto con PATCH', async () => {
    const chat = makeChat({ mode: 'auto' });
    const { calls } = fakeCore({ chats: [chat], messages: { [chat.id]: [] } });
    render(<ChatView projectId="demo" />);
    await waitFor(() => expect(screen.getByTestId('mode-chip').dataset.mode).toBe('auto'));
    expect(screen.getByTestId('mode-chip').className).toContain('text-success');
    expect(screen.getByText('Claude')).toBeTruthy();

    const steps = [
      ['plan', 'text-foreground'],
      ['bypass', 'text-danger'],
      ['auto', 'text-success'],
    ] as const;
    for (const [mode, tone] of steps) {
      fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
      await waitFor(() => expect(screen.getByTestId('mode-chip').dataset.mode).toBe(mode));
      expect(screen.getByTestId('mode-chip').className).toContain(tone);
      expect(screen.getByTestId('composer').dataset.mode).toBe(mode);
    }
    await waitFor(() => expect(patches(calls)).toEqual([{ mode: 'plan' }, { mode: 'bypass' }, { mode: 'auto' }]));
    expect(calls.filter((c) => c.method === 'PATCH').every((c) => c.path === '/chats/chat_abc123')).toBe(true);

    // Dentro de un campo de texto, Shift+Tab es del campo (el Composer decide).
    fireEvent.keyDown(screen.getByLabelText('Mensaje'), { key: 'Tab', shiftKey: true });
    expect(patches(calls)).toHaveLength(3);

    // También con clic en la ficha.
    fireEvent.click(screen.getByTestId('mode-chip'));
    await waitFor(() => expect(patches(calls)).toEqual([{ mode: 'plan' }, { mode: 'bypass' }, { mode: 'auto' }, { mode: 'plan' }]));
  });

  it('el Composer cambia el modo con onModeChange', async () => {
    const chat = makeChat({ mode: 'plan' });
    const { calls } = fakeCore({ chats: [chat], messages: { [chat.id]: [] } });
    render(<ChatView projectId="demo" />);
    await waitFor(() => expect(composer().isDisabled).toBe(false));
    act(() => composer().onModeChange('bypass'));
    await waitFor(() => expect(patches(calls)).toEqual([{ mode: 'bypass' }]));
    expect(screen.getByTestId('mode-chip').dataset.mode).toBe('bypass');
  });
});

describe('propuestas', () => {
  it('aprueba, rechaza y aprueba todo, con el estado como Chip', async () => {
    const live = resetFakeLive();
    const chat = makeChat();
    const t2 = makeProposal('f5-t2');
    const proposals = [makeProposal('f5-t1'), { ...t2, task: { ...t2.task, dependsOn: ['f5-t1'] } }, makeProposal('f5-t3')];
    const { calls, state } = fakeCore({
      chats: [chat],
      messages: {
        [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'Planea', at: at(1) }), makeMessage({ id: 'm2', role: 'assistant', text: 'Propongo tres tareas.', at: at(9) })],
      },
      proposals: { [chat.id]: proposals },
    });
    render(<ChatView projectId="demo" />);

    const card = await screen.findByRole('group', { name: 'Tareas propuestas' });
    expect(within(card).getByText('3 tareas propuestas')).toBeTruthy();
    expect(within(card).getAllByText('Propuesta')).toHaveLength(3);
    expect(within(card).getAllByText('Codex')).toHaveLength(3);
    expect(within(card).getByText('src/f5-t1/**')).toBeTruthy();
    expect(within(screen.getByTestId('proposal-f5-t2')).getByText('f5-t1')).toBeTruthy();

    // Plegable: objetivo y criterios.
    expect(within(card).queryByText('Criterio de f5-t1')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Ver detalle de f5-t1' }));
    expect(within(card).getByText('Criterio de f5-t1')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Aprobar f5-t1' }));
    await waitFor(() => expect(within(screen.getByTestId('proposal-f5-t1')).getByText('Aprobada')).toBeTruthy());
    fireEvent.click(within(card).getByRole('button', { name: 'Rechazar f5-t2' }));
    await waitFor(() => expect(within(screen.getByTestId('proposal-f5-t2')).getByText('Rechazada')).toBeTruthy());
    fireEvent.click(within(card).getByRole('button', { name: /Aprobar todo/ }));
    await waitFor(() => expect(within(screen.getByTestId('proposal-f5-t3')).getByText('Aprobada')).toBeTruthy());

    expect(posts(calls)).toEqual([
      '/chats/chat_abc123/proposals/f5-t1/approve',
      '/chats/chat_abc123/proposals/f5-t2/reject',
      '/chats/chat_abc123/proposals/approve-all',
    ]);
    await waitFor(() => expect(within(card).queryByRole('button', { name: /Aprobar todo/ })).toBeNull());

    // El núcleo avisa por /ws que la flota tomó la tarea.
    const delegated = (state.proposals[chat.id] ?? []).map((p) => (p.task.id === 'f5-t1' ? { ...p, approval: 'delegated' as const } : p));
    act(() => live.emit({ type: 'proposals', chatId: chat.id, proposals: delegated }));
    await waitFor(() => expect(within(screen.getByTestId('proposal-f5-t1')).getByText('Delegada')).toBeTruthy());
  });

  it('si aprobar falla, vuelve al estado anterior y avisa', async () => {
    const chat = makeChat();
    fakeCore({ chats: [chat], proposals: { [chat.id]: [makeProposal('f5-t1')] } }, (method, path) =>
      method === 'POST' && path.endsWith('/approve') ? { status: 409, body: { error: { code: 'conflict', message: 'ya delegada' } } } : undefined,
    );
    render(<ChatView projectId="demo" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aprobar f5-t1' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('ya delegada');
    expect(within(screen.getByTestId('proposal-f5-t1')).getByText('Propuesta')).toBeTruthy();
  });
});

describe('encabezado', () => {
  it('«Cerrar carpeta» vuelve a la portada', async () => {
    fakeCore({ chats: [] });
    render(<ChatView projectId="demo" />);
    await screen.findByText('¿Qué hacemos en Demo?');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar carpeta' }));
    expect(window.location.hash).toBe('#/');
  });

  it('agrega y quita carpetas extra con PATCH', async () => {
    const pickFolder = vi.fn(async () => 'D:\\datos');
    setBridge({ pickFolder });
    const chat = makeChat({ extraRoots: ['C:\\otra'] });
    const { calls } = fakeCore({ chats: [chat], messages: { [chat.id]: [] } });
    render(<ChatView projectId="demo" />);
    await waitFor(() => expect(composer().isDisabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Carpetas extra' }));
    const dialog = await screen.findByRole('dialog', { name: 'Carpetas extra' });
    expect(within(dialog).getByText('C:\\otra')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar carpeta' }));
    await waitFor(() => expect(patches(calls)).toEqual([{ extraRoots: ['C:\\otra', 'D:\\datos'] }]));
    expect(pickFolder).toHaveBeenCalledTimes(1);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Quitar carpeta otra' }));
    await waitFor(() => expect(patches(calls).at(-1)).toEqual({ extraRoots: ['D:\\datos'] }));
  });

  it('cambia de conversación, crea una nueva, renombra y borra', async () => {
    const a = makeChat({ id: 'chat_aaa111', title: 'Alfa', updatedAt: at(50) });
    const b = makeChat({ id: 'chat_bbb222', title: 'Beta', sessionId: 'sess_b', updatedAt: at(10) });
    const { calls } = fakeCore({
      chats: [a, b],
      messages: { chat_aaa111: [makeMessage({ id: 'ma', chatId: 'chat_aaa111', role: 'user', text: 'mensaje de alfa', at: at(1) })], chat_bbb222: [] },
    });
    render(<ChatView projectId="demo" />);
    // Sin chatId en la ruta abre la más reciente.
    await screen.findByText('mensaje de alfa');

    const openPicker = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Conversaciones del proyecto' }));
      return screen.findByRole('dialog', { name: 'Conversaciones' });
    };

    let dialog = await openPicker();
    fireEvent.click(within(dialog).getByText('Beta'));
    expect(window.location.hash).toBe('#/p/demo/c/chat_bbb222');

    dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Renombrar Alfa' }));
    const input = within(dialog).getByLabelText('Nuevo título de la conversación');
    fireEvent.change(input, { target: { value: 'Alfa 2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(patches(calls)).toEqual([{ title: 'Alfa 2' }]));
    await within(dialog).findByText('Alfa 2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar Alfa 2' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/chats/chat_aaa111')).toBe(true));
    await waitFor(() => expect(within(dialog).queryByText('Alfa 2')).toBeNull());
    // El popover sigue abierto tras borrar y la conversación activa pasa a la siguiente.
    expect(dialog.isConnected).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conversaciones del proyecto' }).textContent).toContain('Beta'));

    fireEvent.click(within(dialog).getByText('Nueva conversación'));
    await waitFor(() => expect(window.location.hash).toBe('#/p/demo/c/chat_new001'));
    const created = calls.find((c) => c.method === 'POST' && c.path === '/chats');
    expect(created?.body).toEqual({ projectId: 'demo', mode: 'plan' });
  });
});

describe('estado vacío y primer mensaje', () => {
  it('saluda con 3 sugerencias; elegir una crea el chat con el modo elegido y envía el mensaje', async () => {
    const { calls } = fakeCore({ chats: [] });
    render(<ChatView projectId="demo" />);
    expect(await screen.findByText('¿Qué hacemos en Demo?')).toBeTruthy();
    expect(screen.getByText(/Berland lee la carpeta/)).toBeTruthy();
    const first = 'Revisa el estado del proyecto y propón los siguientes pasos';
    const list = screen.getByRole('button', { name: first }).closest('ul');
    expect(list?.querySelectorAll('li')).toHaveLength(3);

    // Sin chat, Shift+Tab cambia el modo localmente (sin PATCH) y se usa al crearlo.
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(screen.getByTestId('mode-chip').dataset.mode).toBe('bypass');

    fireEvent.click(screen.getByRole('button', { name: first }));
    await waitFor(() => expect(window.location.hash).toBe('#/p/demo/c/chat_new001'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/chats')?.body).toEqual({ projectId: 'demo', mode: 'bypass' });
    await waitFor(() => expect(calls.find((c) => c.path === '/chats/chat_new001/messages' && c.method === 'POST')?.body).toEqual({ text: first, attachmentIds: [] }));
    expect(await screen.findByTestId('user-message')).toBeTruthy();
    expect(screen.getByText('Pensando…')).toBeTruthy();
    expect(patches(calls)).toEqual([]);
  });

  it('el agente suelto pide una carpeta de trabajo antes de crear el chat', async () => {
    const { calls } = fakeCore({ chats: [] }, (method, path) => (method === 'POST' && path === '/fs/pick-folder' ? { body: { path: null } } : undefined));
    render(<ChatView projectId={null} />);
    expect(await screen.findByText('¿En qué te ayudo?')).toBeTruthy();
    expect(screen.getByText('Agente suelto')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Mensaje'), { target: { value: 'hola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Elige una carpeta de trabajo');
    expect(posts(calls)).toEqual(['/fs/pick-folder']);
  });
});

describe('adjuntos', () => {
  it('sube los bytes en la web y registra la ruta en Electron', async () => {
    const chat = makeChat();
    const { calls } = fakeCore({ chats: [chat] }, (_method, path) => {
      if (path === '/attachments/by-path') return { body: { attachment: makeAttachment({ id: 'att_path01', source: 'path' }) } };
      if (path.startsWith('/attachments?name=')) return { body: { attachment: makeAttachment({ id: 'att_up0001' }) } };
      return undefined;
    });
    render(<ChatView projectId="demo" />);
    await waitFor(() => expect(composer().isDisabled).toBe(false));
    const file = new File(['hola'], 'nota.txt', { type: 'text/plain' });

    expect((await composer().onAttach(file)).id).toBe('att_up0001');
    const upload = calls.find((c) => c.path.startsWith('/attachments?'));
    expect(upload?.path).toBe('/attachments?name=nota.txt');
    expect(upload?.headers.get('Content-Type')).toBe('text/plain');

    setBridge({ pathForFile: () => 'C:\\Users\\yo\\nota.txt' });
    expect((await composer().onAttach(file)).id).toBe('att_path01');
    expect(calls.find((c) => c.path === '/attachments/by-path')?.body).toEqual({ path: 'C:\\Users\\yo\\nota.txt' });
  });
});

describe('conversación que ya no existe', () => {
  it('avisa si el chat de la ruta no existe y lleva a la más reciente', async () => {
    const chat = makeChat();
    fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'la buena', at: at(1) })] } });
    window.history.replaceState(null, '', '/#/p/demo/c/chat_zzz999');
    render(<ChatView projectId="demo" chatId="chat_zzz999" />);
    expect(await screen.findByText('Esta conversación ya no existe')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ir a la última conversación' }));
    expect(await screen.findByText('la buena')).toBeTruthy();
    expect(window.location.hash).toBe('#/p/demo');
  });

  it('si otra ventana la borra (chat_deleted), lo dice', async () => {
    const live = resetFakeLive();
    const chat = makeChat();
    fakeCore({ chats: [chat], messages: { [chat.id]: [makeMessage({ id: 'm1', role: 'user', text: 'hola', at: at(1) })] } });
    render(<ChatView projectId="demo" />);
    await screen.findByText('hola');
    act(() => live.emit({ type: 'chat_deleted', chatId: chat.id }));
    expect(await screen.findByText('Esta conversación ya no existe')).toBeTruthy();
  });
});

describe('núcleo sin /chats', () => {
  it('muestra un aviso claro en vez de romperse (404 de ruta)', async () => {
    installFetch(() => undefined);
    render(<ChatView projectId="demo" />);
    expect(await screen.findByText('El chat con la mente aún no está disponible')).toBeTruthy();
    expect(screen.getByText(/núcleo de Berland/)).toBeTruthy();
    expect((screen.getByLabelText('Mensaje') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('también si el núcleo responde HTML', async () => {
    installFetch(() => ({ raw: '<!doctype html><title>x</title>', contentType: 'text/html' }));
    render(<ChatView projectId="demo" />);
    expect(await screen.findByText('El chat con la mente aún no está disponible')).toBeTruthy();
  });
});
