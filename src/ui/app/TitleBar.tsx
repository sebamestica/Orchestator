import { ArrowLeft, ArrowRight, Minus, PanelLeft, PanelRight, Square, X } from 'lucide-react';
import { desktop } from '../api/bridge.ts';
import { IconButton } from '../components/IconButton.tsx';
import { useApp } from '../store/app.ts';

/** Barra de título propia: arrastra la ventana en Electron; en la web es una barra fina. */
export function TitleBar() {
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const togglePanel = useApp((s) => s.togglePanel);
  const panelOpen = useApp((s) => s.panelOpen);
  const win = desktop?.window;
  return (
    <div className="titlebar flex shrink-0 items-center gap-0.5 pl-2 text-muted">
      <IconButton label="Mostrar u ocultar la barra lateral (Ctrl+B)" size="sm" onClick={toggleSidebar}>
        <PanelLeft className="size-4" aria-hidden="true" />
      </IconButton>
      <IconButton label="Atrás" size="sm" onClick={() => window.history.back()}>
        <ArrowLeft className="size-4" aria-hidden="true" />
      </IconButton>
      <IconButton label="Adelante" size="sm" onClick={() => window.history.forward()}>
        <ArrowRight className="size-4" aria-hidden="true" />
      </IconButton>
      <div className="flex-1" />
      <IconButton label="Mostrar u ocultar los agentes en vivo" size="sm" active={panelOpen} onClick={() => togglePanel()}>
        <PanelRight className="size-4" aria-hidden="true" />
      </IconButton>
      {win ? (
        <div className="ml-1 flex h-full items-stretch" data-no-drag>
          <button type="button" aria-label="Minimizar" onClick={() => win.minimize()} className="flex w-11 items-center justify-center hover:bg-foreground/[0.06] hover:text-foreground">
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <button type="button" aria-label="Maximizar" onClick={() => win.toggleMaximize()} className="flex w-11 items-center justify-center hover:bg-foreground/[0.06] hover:text-foreground">
            <Square className="size-3.5" aria-hidden="true" />
          </button>
          <button type="button" aria-label="Cerrar" onClick={() => win.close()} className="flex w-11 items-center justify-center hover:bg-danger hover:text-white">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <span className="w-2" />
      )}
    </div>
  );
}
