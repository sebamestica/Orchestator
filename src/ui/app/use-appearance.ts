/**
 * Tema y efectos de la interfaz: clase `dark`/`light`, `data-theme` y `data-effects` en `<html>`.
 * Con el tema «Sistema» sigue a Windows en vivo (evento `change` de `prefers-color-scheme`). El último tema
 * aplicado queda en `localStorage` para pintarlo al arrancar, antes de que lleguen los ajustes del núcleo.
 */
import { useEffect } from 'react';
import { useApp } from '../store/app.ts';

export const THEME_STORAGE_KEY = 'berland.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

type Theme = 'dark' | 'light';

function paint(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
  root.dataset.theme = theme;
}

function remember(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Sin almacenamiento solo vuelve el destello al arrancar.
  }
}

/** Antes de montar React: pinta el último tema aplicado, si lo hay. Si no, queda el de `index.html`. */
export function applyStoredTheme(): void {
  let stored: string | null | undefined;
  try {
    stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
  } catch {
    return;
  }
  if (stored === 'dark' || stored === 'light') paint(stored);
}

export function useAppearance(): void {
  // Hasta que el núcleo responde, el store trae los ajustes por defecto: aplicarlos pisaría el tema guardado.
  const known = useApp((s) => s.core === 'ready');
  const theme = useApp((s) => s.settings.appearance.theme);
  const reducedEffects = useApp((s) => s.settings.appearance.reducedEffects);

  useEffect(() => {
    if (!known) return;
    const query = theme === 'system' ? window.matchMedia(DARK_QUERY) : null;
    const apply = () => {
      const effective: Theme = theme === 'dark' || query?.matches === true ? 'dark' : 'light';
      paint(effective);
      remember(effective);
    };
    apply();
    query?.addEventListener('change', apply);
    return () => query?.removeEventListener('change', apply);
  }, [known, theme]);

  useEffect(() => {
    document.documentElement.dataset.effects = reducedEffects ? 'reduced' : 'full';
  }, [reducedEffects]);
}
