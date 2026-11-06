import { useApp } from '../store/app.ts';
import { panelRoute, type Route } from './routes.ts';
import { useMediaQuery } from './use-media-query.ts';

/** Desde este ancho (`lg` de Tailwind) el panel va en línea; por debajo se superpone al contenido. */
export const PANEL_INLINE_QUERY = '(min-width: 64rem)';

/**
 * Cuándo se ve el panel de agentes en vivo, para `App` (que lo dibuja) y la barra de título (que lo abre).
 * En línea sigue `panelOpen`; superpuesto, `panelOverlayOpen`, que empieza cerrado para no tapar el chat.
 */
export function useAgentsPanel(route: Route) {
  const core = useApp((s) => s.core);
  const inline = useMediaQuery(PANEL_INLINE_QUERY);
  const open = useApp((s) => (inline ? s.panelOpen : s.panelOverlayOpen));
  const available = core === 'ready' && panelRoute(route);
  const toggle = (value?: boolean) => {
    const app = useApp.getState();
    if (inline) app.togglePanel(value);
    else app.togglePanelOverlay(value);
  };
  return { available, inline, shown: available && open, toggle };
}
