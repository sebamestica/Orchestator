/** Textos y formatos de la vista de chat (en español, frases cortas). */
import type { MindMode } from '../../../shared/api.ts';

/** Nombre visible de la app (pedido del usuario: «Berland»; los nombres internos no cambian). */
export const APP_NAME = 'Berland';

/** Textos de cada modo: `hint` corto para la ficha del chat y `description` larga para Ajustes › Mente. */
export const MODE_INFO: Record<MindMode, { label: string; hint: string; description: string; tone: string }> = {
  plan: {
    label: 'Plan',
    hint: 'Propone tareas y espera tu aprobación.',
    description: 'La mente lee y propone tareas; nada se ejecuta hasta que apruebas.',
    tone: 'text-foreground',
  },
  auto: {
    label: 'Auto',
    hint: 'Aprueba y delega sola; pasar a main lo apruebas tú.',
    description: 'La mente aprueba y delega sola; integra tras el gate. Pasar a main te lo pregunta.',
    tone: 'text-success',
  },
  bypass: {
    label: 'Bypass',
    hint: 'Edita y ejecuta comandos sin preguntar; delega lo largo y pasa a main si el gate pasa.',
    description: 'La mente hace el trabajo ella misma, sin preguntar: en un proyecto edita archivos y ejecuta comandos en la carpeta, delega lo largo a la flota y pasa a main si el gate pasa. Además lee fuera de la carpeta.',
    tone: 'text-danger',
  },
  chat: {
    label: 'Chat',
    hint: 'Como Claude Code: responde y hace los cambios en la carpeta, sin flota.',
    description: 'Como Claude Code: la mente responde y hace los cambios en la carpeta ella misma, sin crear tareas ni usar la flota.',
    tone: 'text-accent',
  },
};

export function formatCost(usd: number): string {
  if (usd === 0) return 'US$0';
  if (usd < 0.01) return '<US$0,01';
  return `US$${usd.toFixed(2).replace('.', ',')}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace('.', ',')} k`;
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'Ahora';
  if (min < 60) return `Hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Ayer';
  return `Hace ${d} días`;
}

/** Último tramo de una ruta (Windows o POSIX), para mostrar carpetas cortas. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export const chatTitle = (title: string) => title.trim() || 'Conversación sin título';
