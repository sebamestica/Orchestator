// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LiveMessage } from '../../../src/ui/api/live.ts';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import PluginsView from '../../../src/ui/features/plugins/PluginsView.tsx';

const live = vi.hoisted(() => ({ listener: null as ((message: LiveMessage) => void) | null, unsubscribe: vi.fn() }));
vi.mock('../../../src/ui/api/live.ts', () => ({ getLive: () => ({ subscribe: (fn: (message: LiveMessage) => void) => { live.listener = fn; return live.unsubscribe; } }) }));
const chrome = { id: 'chrome', name: 'Chrome', description: 'Navega con tus sesiones', status: 'disconnected', agents: [], steps: ['Activa la depuración remota'], updatedAt: '2026-11-04T10:00:00Z' };
const canva = { ...chrome, id: 'canva', name: 'Canva', description: 'Diseña con tu cuenta', steps: [] };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => {
  setCoreEndpoint({ url: '', wsUrl: '', token: 'test' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ plugins: [chrome, canva] })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.orq; });
describe('Plugins', () => {
  it('lista los plugins, pasos y el anuncio', async () => {
    render(<PluginsView />);
    expect(await screen.findByText('Chrome')).toBeTruthy();
    expect(screen.getByText('Canva')).toBeTruthy();
    expect(screen.getByText('Activa la depuración remota')).toBeTruthy();
    expect(screen.getByText('Más plugins pronto')).toBeTruthy();
  });
  it('conecta Chrome con el perfil personal', async () => {
    const fetcher = vi.mocked(fetch);
    fetcher.mockResolvedValueOnce(reply({ plugins: [chrome] })).mockResolvedValueOnce(reply({ plugin: { ...chrome, status: 'connected' } }));
    render(<PluginsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Chrome' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/plugins/chrome/connect', expect.objectContaining({ body: JSON.stringify({ profile: 'personal' }) })));
    expect(await screen.findByRole('button', { name: 'Desconectar Chrome' })).toBeTruthy();
  });
  it('abre el authUrl de Canva', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValueOnce(reply({ plugins: [canva] })).mockResolvedValueOnce(reply({ plugin: { ...canva, status: 'connecting', authUrl: 'https://www.canva.com/oauth' } }));
    render(<PluginsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Canva' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://www.canva.com/oauth', '_blank', 'noopener,noreferrer'));
  });
  it('permite elegir el perfil propio de los agentes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply({ plugins: [chrome] })).mockResolvedValueOnce(reply({ plugin: { ...chrome, status: 'connected' } }));
    render(<PluginsView />);
    const selector = await screen.findByRole('button', { name: /Perfil de Chrome/ });
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Perfil propio de los agentes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conectar Chrome' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/plugins/chrome/connect', expect.objectContaining({ body: JSON.stringify({ profile: 'agente' }) })));
  });
  it('desconecta un plugin conectado', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply({ plugins: [{ ...chrome, status: 'connected' }] })).mockResolvedValueOnce(reply({ plugin: chrome }));
    render(<PluginsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar Chrome' }));
    expect(await screen.findByRole('button', { name: 'Conectar Chrome' })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/plugins/chrome/disconnect', expect.objectContaining({ method: 'POST' }));
  });
  it('agrupa eventos en vivo por cuadro y desconecta la suscripción', async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', vi.fn((fn: FrameRequestCallback) => { frame = fn; return 1; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const view = render(<PluginsView />);
    await screen.findByText('Chrome');
    act(() => {
      live.listener?.({ type: 'plugin', plugin: { ...chrome, id: 'chrome', status: 'connecting', detail: 'Esperando', updatedAt: '2026-11-04T11:00:00Z' } });
      live.listener?.({ type: 'plugin', plugin: { ...chrome, id: 'chrome', status: 'connected', detail: 'Sesión lista', updatedAt: '2026-11-04T12:00:00Z' } });
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    act(() => frame?.(0));
    expect(screen.getByText('Sesión lista')).toBeTruthy();
    expect(screen.queryByText('Esperando')).toBeNull();
    view.unmount(); expect(live.unsubscribe).toHaveBeenCalled();
  });
  it.each([404, 501])('avisa cuando el backend responde %s', async (status) => {
    vi.mocked(fetch).mockResolvedValue(reply({}, status));
    render(<PluginsView />);
    expect((await screen.findByRole('alert')).textContent).toContain('todavía no están disponibles');
  });
});
