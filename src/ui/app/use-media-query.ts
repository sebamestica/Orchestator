import { useCallback, useSyncExternalStore } from 'react';

/** `true` mientras la ventana cumple la media query (se actualiza al cambiar el ancho). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
}
