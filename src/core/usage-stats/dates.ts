/** Días `AAAA-MM-DD` del resumen de uso: siempre en una zona horaria IANA explícita. */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Formateador de días en `timeZone`. Lanza `RangeError` si la zona no existe. */
export function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    dayFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Zona horaria del sistema (la misma que usa el almacén por defecto). */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Fecha del calendario real (rechaza `2026-02-30`). */
export function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días de `from` a `to`, ambos incluidos (0 si `to` es anterior). */
export function dayCount(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export const minDay = (a: string, b: string): string => (a < b ? a : b);
export const maxDay = (a: string, b: string): string => (a > b ? a : b);
