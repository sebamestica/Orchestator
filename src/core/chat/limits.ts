/**
 * Topes de gasto de la mente (autoeval-gasto-01): saldos y avisos. Los aplica `ChatService`: el presupuesto del agente
 * y el tope diario antes de cada mensaje; el tope por mensaje y el de turnos autónomos en vivo, con el costo estimado
 * del stream (no incluye lo que restaura un `resume`).
 */
import type { MindLimits } from '../../shared/index.ts';

/** Respaldo en el SDK: ningún proceso de la mente encadena más turnos de modelo que esto. */
export const MIND_MAX_TURNS = 200;
/** Un saldo menor ya no alcanza para nada: se trata como agotado (y evita restos de coma flotante). */
const EXHAUSTED_USD = 1e-6;

/** Gasto en vivo desde el último mensaje del usuario (por sesión del SDK: el costo del stream empieza en 0). */
export interface MindSpend {
  /** Costo del stream al llegar el último mensaje del usuario: base del tope por mensaje. */
  base: number;
  /** Costo del stream en el último `result`: lo que va después aún no está en el costo guardado del chat. */
  mark: number;
  /** Centavos en curso que ya se difundieron (la cabecera se mueve durante el turno). */
  shownCents: number;
  /** Ya se cortó por un tope desde el último mensaje del usuario. */
  capped: boolean;
  /** Turnos que la mente abrió sola desde el último mensaje del usuario. */
  autonomous: number;
}

export function freshSpend(base = 0): MindSpend {
  return { base, mark: base, shownCents: 0, capped: false, autonomous: 0 };
}

function usd(value: number): string {
  return `${value.toFixed(2).replace('.', ',')} USD`;
}

export function exhausted(left: number | undefined): boolean {
  return left !== undefined && left <= EXHAUSTED_USD;
}

/** Lo que queda del tope diario; `undefined` sin tope. */
export function dayLeftUsd(limits: MindLimits, spentToday: number): number | undefined {
  return limits.dayUsd === null ? undefined : limits.dayUsd - spentToday;
}

/** Tope de la sesión del SDK: el menor de los saldos conocidos. */
export function sessionCapUsd(...lefts: readonly (number | undefined)[]): number | undefined {
  const known = lefts.filter((v): v is number => v !== undefined);
  return known.length ? Math.min(...known) : undefined;
}

export function dayCapMessage(spentToday: number, dayUsd: number): string {
  return `La mente llegó a su tope diario: ${usd(spentToday)} de ${usd(dayUsd)} hoy. Súbelo o quítalo en Ajustes → Mente y subagentes`;
}

export function turnCapNotice(spent: number, turnUsd: number): string {
  return `El turno llegó a ${usd(spent)} (tope por turno: ${usd(turnUsd)}) y lo detuve. Escribe «sigue» para continuar.`;
}

export function chainCapNotice(maxAutonomousTurns: number): string {
  return `La mente abrió ${maxAutonomousTurns} turnos seguidos sin mensaje tuyo (tope de turnos autónomos) y la detuve junto con sus subagentes. Escribe «sigue» para continuar.`;
}
