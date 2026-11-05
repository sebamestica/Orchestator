/** Formato de cifras de la sección «Uso y gasto»: USD, tokens compactos y días cortos (es). */

const usd2 = new Intl.NumberFormat('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd4 = new Intl.NumberFormat('es', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const compact = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('es');
const pct = new Intl.NumberFormat('es', { style: 'percent', maximumFractionDigits: 0 });
const shortDay = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const multiplier = new Intl.NumberFormat('es', { maximumFractionDigits: 4 });

/** `12,34 USD`; por debajo de 1 USD, hasta 4 decimales (`0,0169 USD`). */
export function formatUsd(n: number): string {
  return `${(Math.abs(n) >= 1 || n === 0 ? usd2 : usd4).format(n)} USD`;
}

/** `1,2 M`, `48 mil`, `950`. */
export function formatTokens(n: number): string {
  return compact.format(n);
}

/** Número completo con separador de miles (para `title`). */
export function formatFull(n: number): string {
  return full.format(n);
}

export function formatPercent(fraction: number): string {
  return pct.format(fraction);
}

/** `4 nov` para un día `AAAA-MM-DD` (sin correr el día por la zona horaria). */
export function formatDay(day: string): string {
  return shortDay.format(new Date(`${day}T12:00:00Z`)).replace('.', '');
}

/** `1,3×`. */
export function formatMultiplier(n: number): string {
  return `${multiplier.format(n)}×`;
}

/** Lee lo que escribe una persona (`1,3`, `1.3`): número o `null` si no es válido. */
export function parseMultiplier(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) ? n : null;
}
