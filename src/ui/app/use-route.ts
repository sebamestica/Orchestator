import { useSyncExternalStore } from 'react';
import { parseRoute, type Route } from './routes.ts';

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

const snapshot = () => window.location.hash;

/** Ruta actual (se actualiza con el fragmento). */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '');
  return parseRoute(hash);
}
