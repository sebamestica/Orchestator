import type { CSSProperties } from 'react';
import { BOOT_CSS, bootMarkup } from '../../shared/boot-animation.ts';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** Colores del tema vigente (claro u oscuro) para la animación. */
const THEMED = { '--boot-ink': 'var(--foreground)', '--boot-canvas': 'var(--canvas)', '--boot-muted': 'var(--muted)' } as CSSProperties;

interface BootScreenProps {
  /** Lo que se espera; un «…» final se muestra como puntos animados. */
  label: string;
  /**
   * Sin la entrada (la «B» que se dibuja y los agentes que aparecen): la interfaz toma el relevo de la pantalla de
   * arranque del escritorio, que ya la mostró. Por defecto, `true`.
   */
  settled?: boolean;
}

/**
 * Pantalla de espera mientras la interfaz conecta con el núcleo: la misma animación que la del escritorio
 * (`src/shared/boot-animation.ts`, marcado fijo), con los colores del tema.
 */
export function BootScreen({ label, settled = true }: BootScreenProps) {
  return (
    <div role="status" aria-label={label} data-testid="boot-screen" className="flex flex-1 items-center justify-center" style={THEMED}>
      <style>{BOOT_CSS}</style>
      {/* Marcado propio y constante; la etiqueta va escapada. */}
      <div dangerouslySetInnerHTML={{ __html: bootMarkup(escapeHtml(label), settled) }} />
    </div>
  );
}
