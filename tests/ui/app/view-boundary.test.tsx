// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { ViewBoundary } from '../../../src/ui/app/ViewBoundary.tsx';
import { reloadOnPreloadError } from '../../../src/ui/app/preload-reload.ts';

const Rota = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
function Lanza(): never {
  throw new Error('vista rota en render');
}
const Sana = () => <p>vista sana</p>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
// React informa por consola de cada error capturado; aquí se espera.
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('ViewBoundary', () => {
  it('un trozo perezoso que no carga muestra el aviso y deja el resto montado', async () => {
    quiet();
    render(
      <div>
        <span>barra</span>
        <ViewBoundary key="a">
          <Suspense fallback={null}>
            <Rota />
          </Suspense>
        </ViewBoundary>
      </div>,
    );
    expect(await screen.findByText('No se pudo cargar esta vista')).toBeTruthy();
    expect(screen.getByText('Failed to fetch dynamically imported module')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recargar' })).toBeTruthy();
    expect(screen.getByText('barra')).toBeTruthy();
  });

  it('una excepción de render muestra el mismo aviso; otra ruta (resetKey) con una vista sana lo quita', async () => {
    quiet();
    const view = render(
      <div>
        <span>barra</span>
        <ViewBoundary resetKey="#/tablero">
          <Lanza />
        </ViewBoundary>
      </div>,
    );
    expect(await screen.findByText('No se pudo cargar esta vista')).toBeTruthy();
    expect(screen.getByText('barra')).toBeTruthy();
    view.rerender(
      <div>
        <span>barra</span>
        <ViewBoundary resetKey="#/plugins">
          <Sana />
        </ViewBoundary>
      </div>,
    );
    expect(await screen.findByText('vista sana')).toBeTruthy();
    expect(screen.queryByText('No se pudo cargar esta vista')).toBeNull();
  });

  it('«Recargar» recarga la página una vez', async () => {
    quiet();
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    render(
      <ViewBoundary>
        <Lanza />
      </ViewBoundary>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Recargar' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('recarga ante vite:preloadError', () => {
  const preloadError = () => {
    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  it('recarga una sola vez seguida y deja el resto al aviso de la vista', () => {
    const reload = vi.fn();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const off = reloadOnPreloadError(window, reload);
    try {
      expect(preloadError().defaultPrevented).toBe(true);
      expect(preloadError().defaultPrevented).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
      // Pasado un rato (otra recompilación), vuelve a recargar.
      now.mockReturnValue(1_000_000 + 60_000);
      expect(preloadError().defaultPrevented).toBe(true);
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });
});
