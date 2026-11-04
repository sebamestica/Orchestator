import { z } from 'zod';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Rect;
  maximized: boolean;
}

/** Opciones de tamaño y posición para `new BrowserWindow` (sin x/y, Electron la centra). */
export interface WindowPlacement {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

export const MIN_SIZE = { width: 960, height: 600 } as const;
export const DEFAULT_SIZE = { width: 1280, height: 800 } as const;
/** Parte de la ventana que tiene que verse en alguna pantalla para conservar su posición. */
const VISIBLE = { width: 120, height: 40 } as const;

const coord = z.number().int().min(-100_000).max(100_000);
const size = z.number().int().min(1).max(100_000);
const stateSchema = z.strictObject({
  bounds: z.strictObject({ x: coord, y: coord, width: size, height: size }),
  maximized: z.boolean(),
});

/** Estado guardado (`window-state.json`); cualquier cosa rara da `null` y la ventana usa el tamaño por defecto. */
export function parseWindowState(text: string | null | undefined): WindowState | null {
  if (!text) return null;
  try {
    const r = stateSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function serializeWindowState(state: WindowState): string {
  const r = (n: number) => Math.round(n);
  const b = state.bounds;
  return `${JSON.stringify({ bounds: { x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) }, maximized: state.maximized })}\n`;
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * Coloca la ventana con el estado guardado: tamaño entre el mínimo (960×600) y la pantalla más grande, y
 * posición solo si la barra de título queda visible en alguna pantalla (si se desconectó un monitor, se centra).
 */
export function placeWindow(saved: WindowState | null, workAreas: readonly Rect[]): WindowPlacement {
  const largest = workAreas.reduce<{ width: number; height: number }>(
    (acc, a) => ({ width: Math.max(acc.width, a.width), height: Math.max(acc.height, a.height) }),
    { width: 0, height: 0 },
  );
  const maxW = largest.width > 0 ? Math.max(MIN_SIZE.width, largest.width) : Number.POSITIVE_INFINITY;
  const maxH = largest.height > 0 ? Math.max(MIN_SIZE.height, largest.height) : Number.POSITIVE_INFINITY;
  const fit = (w: number, h: number) => ({
    width: Math.round(Math.min(maxW, Math.max(MIN_SIZE.width, w))),
    height: Math.round(Math.min(maxH, Math.max(MIN_SIZE.height, h))),
  });
  if (!saved) return { ...fit(DEFAULT_SIZE.width, DEFAULT_SIZE.height), maximized: false };
  const dims = fit(saved.bounds.width, saved.bounds.height);
  const rect: Rect = { x: saved.bounds.x, y: saved.bounds.y, ...dims };
  // La franja de arriba (barra de título propia) tiene que caer en una pantalla.
  const titleStrip: Rect = { ...rect, height: Math.min(rect.height, VISIBLE.height) };
  const visible = workAreas.some((a) => {
    const o = overlap(titleStrip, a);
    return o.width >= VISIBLE.width && o.height >= Math.min(VISIBLE.height, titleStrip.height);
  });
  return visible ? { ...dims, x: rect.x, y: rect.y, maximized: saved.maximized } : { ...dims, maximized: saved.maximized };
}
