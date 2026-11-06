// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api.ts';
import { applyStoredTheme, THEME_STORAGE_KEY, useAppearance } from '../../../src/ui/app/use-appearance.ts';
import { useApp } from '../../../src/ui/store/app.ts';

type Listener = () => void;
/** MediaQueryList falso: `matches` modificable y oyentes de `change` a la vista. */
const media = { matches: false, listeners: new Set<Listener>() };
const root = document.documentElement;

function appearance(theme: Settings['appearance']['theme']) {
  useApp.setState({ core: 'ready', settings: { ...DEFAULT_SETTINGS, appearance: { theme, reducedEffects: false } } });
}

function windowsTurns(dark: boolean) {
  media.matches = dark;
  act(() => {
    for (const listener of media.listeners) listener();
  });
}

beforeEach(() => {
  media.matches = false;
  media.listeners.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return media.matches;
    },
    media: query,
    addEventListener: (_type: 'change', listener: Listener) => media.listeners.add(listener),
    removeEventListener: (_type: 'change', listener: Listener) => media.listeners.delete(listener),
  }));
  localStorage.clear();
  root.className = 'dark';
  root.dataset.theme = 'dark';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useApp.setState({ core: 'starting', settings: DEFAULT_SETTINGS });
});

describe('tema «Sistema»', () => {
  it('sigue a Windows mientras la app está abierta', () => {
    appearance('system');
    renderHook(() => useAppearance());
    expect(root.classList.contains('light')).toBe(true);
    expect(root.dataset.theme).toBe('light');

    windowsTurns(true);
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
    expect(root.dataset.theme).toBe('dark');
  });

  it('deja de escuchar a Windows al elegir un tema fijo y al desmontar', () => {
    appearance('system');
    const hook = renderHook(() => useAppearance());
    expect(media.listeners.size).toBe(1);

    act(() => appearance('dark'));
    expect(media.listeners.size).toBe(0);
    expect(root.dataset.theme).toBe('dark');

    act(() => appearance('system'));
    expect(media.listeners.size).toBe(1);
    hook.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('no vuelve a montar el oyente con cada mensaje de ajustes de /ws', () => {
    appearance('system');
    renderHook(() => useAppearance());
    expect(media.listeners.size).toBe(1);
    const first = [...media.listeners][0];
    act(() => useApp.getState().applyLive({ type: 'settings', settings: { ...useApp.getState().settings, concurrency: 5 } }));
    expect([...media.listeners]).toEqual([first]);
  });
});

describe('arranque sin destello', () => {
  it('pinta el último tema aplicado antes de que lleguen los ajustes', () => {
    appearance('light');
    const hook = renderHook(() => useAppearance());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    hook.unmount();

    // Siguiente arranque: <html> viene en oscuro del index.html y el store aún tiene los valores por defecto.
    root.className = 'dark';
    root.dataset.theme = 'dark';
    useApp.setState({ core: 'starting', settings: DEFAULT_SETTINGS });
    applyStoredTheme();
    renderHook(() => useAppearance());
    expect(root.classList.contains('light')).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.dataset.theme).toBe('light');
  });

  it('sin tema guardado deja el de index.html', () => {
    applyStoredTheme();
    expect(root.dataset.theme).toBe('dark');
  });
});
