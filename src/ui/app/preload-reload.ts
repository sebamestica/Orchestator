/**
 * Vite emite `vite:preloadError` cuando no puede traer un trozo dinámico: pasa si se recompiló `dist/ui`
 * con la ventana abierta y el hash viejo ya no existe. Recargar trae el `index.html` nuevo (se sirve con
 * `no-store`). Se recarga como mucho una vez cada `GAP_MS` para no entrar en bucle; si no basta, el
 * `ViewBoundary` de la vista muestra el aviso con «Recargar».
 */
const KEY = 'berland:recarga-por-trozo';
const GAP_MS = 10_000;

function lastReload(win: Window): number {
  try {
    return Number(win.sessionStorage.getItem(KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function markReload(win: Window, at: number): void {
  try {
    win.sessionStorage.setItem(KEY, String(at));
  } catch {
    // Sin sessionStorage no queda marca: se recarga cada vez, que es lo que pasaría con F5.
  }
}

export function reloadOnPreloadError(win: Window, reload: () => void): () => void {
  const onError = (event: Event) => {
    const now = Date.now();
    if (now - lastReload(win) < GAP_MS) return;
    markReload(win, now);
    event.preventDefault();
    reload();
  };
  win.addEventListener('vite:preloadError', onError);
  return () => win.removeEventListener('vite:preloadError', onError);
}
