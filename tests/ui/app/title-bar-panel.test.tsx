// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../../../src/ui/app/App.tsx';
import { useApp } from '../../../src/ui/store/app.ts';

// El núcleo nunca responde: el estado lo fija cada prueba. Las vistas no importan aquí.
vi.mock('../../../src/ui/api/bridge.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ui/api/bridge.ts')>()),
  resolveCore: () => new Promise(() => undefined),
  desktop: undefined,
}));
vi.mock('../../../src/ui/api/live.ts', () => ({ getLive: () => null, startLive: vi.fn() }));
vi.mock('../../../src/ui/app/Sidebar.tsx', () => ({ Sidebar: () => null }));
vi.mock('../../../src/ui/features/home/HomeView.tsx', () => ({ HomeView: () => null }));
vi.mock('../../../src/ui/features/chat/ChatView.tsx', () => ({ default: () => null }));
vi.mock('../../../src/ui/features/board/BoardView.tsx', () => ({ default: () => null }));
vi.mock('../../../src/ui/features/settings/SettingsView.tsx', () => ({ default: () => null }));
vi.mock('../../../src/ui/features/plugins/PluginsView.tsx', () => ({ default: () => null }));

let wide: boolean;
const button = () => screen.getByRole('button', { name: 'Mostrar u ocultar los agentes en vivo' });
const panel = () => screen.queryByRole('complementary', { name: 'Agentes en vivo' });
function open(hash: string) {
  window.location.hash = hash;
  render(<App />);
}

beforeEach(() => {
  wide = true;
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: wide, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
  useApp.setState({ core: 'ready', live: 'closed', panelOpen: true, panelOverlayOpen: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('botón de agentes en vivo', () => {
  it.each(['#/ajustes/general', '#/', '#/plugins'])('en %s está deshabilitado y apagado', (hash) => {
    open(hash);
    expect(button()).toHaveProperty('disabled', true);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().title).toMatch(/chats y en el tablero/);
    expect(panel()).toBeNull();
  });
  it.each(['#/conversaciones', '#/tablero'])('en %s muestra y oculta el panel en línea', (hash) => {
    open(hash);
    expect(button()).toHaveProperty('disabled', false);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(panel()?.hasAttribute('data-overlay')).toBe(false);
    fireEvent.click(button());
    expect(panel()).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button());
    expect(panel()).toBeTruthy();
  });
  it('sin ancho no se abre solo; al pulsarlo se superpone visible y se cierra con Escape', () => {
    wide = false;
    open('#/conversaciones');
    expect(panel()).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button());
    const aside = panel();
    expect(aside?.hasAttribute('data-overlay')).toBe(true);
    expect(aside?.className.split(/\s+/)).not.toContain('hidden');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    if (!aside) throw new Error('falta el panel');
    fireEvent.keyDown(aside, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(useApp.getState().panelOpen).toBe(true);
  });
  it('mientras el núcleo arranca está deshabilitado', () => {
    useApp.setState({ core: 'starting' });
    open('#/conversaciones');
    expect(button()).toHaveProperty('disabled', true);
    expect(panel()).toBeNull();
  });
});
