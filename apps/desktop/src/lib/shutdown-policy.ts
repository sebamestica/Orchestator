import type { RunningCheck } from './core-client.ts';

/**
 * De quién es el núcleo al que está conectada la app:
 * - `launched`: lo lanzó esta ventana al abrir.
 * - `adopted`: lo lanzó Berland en una apertura anterior (sesión cifrada válida) y siguió vivo.
 * - `external`: lo abrió otra persona o programa (`iniciar` a mano, la flota de A0, `ORQ_CORE_TOKEN`).
 */
export type CoreOwnership = 'launched' | 'adopted' | 'external';

export interface ShutdownDecision {
  stop: boolean;
  reason: string;
}

/** Se acabó el plazo del cierre antes de empezar a apagar: no se mata nada y la sesión queda para la próxima apertura. */
export const CLOSE_TIMED_OUT: ShutdownDecision = { stop: false, reason: 'el cierre tardó demasiado: el núcleo sigue vivo' };

/**
 * Regla al cerrar la ventana: el núcleo se apaga solo si lo abrió Berland **y** se sabe con certeza que
 * no hay tareas en curso. Con tareas en curso, sin respuesta del núcleo o si el núcleo es ajeno, sigue
 * vivo (la flota no se corta) y la próxima apertura lo reutiliza.
 */
export function decideOnClose(ownership: CoreOwnership | null, check: RunningCheck | null): ShutdownDecision {
  if (ownership === null) return { stop: false, reason: 'no hay núcleo conectado' };
  if (ownership === 'external') return { stop: false, reason: 'el núcleo no lo abrió Berland: sigue vivo' };
  if (check === null || check.status !== 'ok') return { stop: false, reason: 'no se pudo saber si hay tareas en curso: el núcleo sigue vivo' };
  if (check.running > 0) {
    return { stop: false, reason: `${check.running} ${check.running === 1 ? 'trabajo en curso' : 'trabajos en curso'} (tareas o la mente): el núcleo sigue vivo` };
  }
  return { stop: true, reason: 'sin tareas en curso: el núcleo se apaga con la ventana' };
}
