/**
 * Cierre de un turno que el usuario detuvo con «Detener». El SDK lo termina con un `result` de subtipo
 * `error_during_execution` y un diagnóstico interno («[ede_diagnostic] …») que el traductor convierte en `error` +
 * `done(false)`. No es un fallo: se queda el uso (el gasto cuenta), se quitan los errores y el `done(false)` pasa a
 * `status cancelled`, para que la sesión no quede `failed` ni el hilo muestre un error rojo.
 */
import type { AgentEvent } from '../../shared/index.ts';

export const INTERRUPTED_DETAIL = 'interrumpido por ti';

export function asInterrupted(events: readonly AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const e of events) {
    if (e.type === 'error') continue;
    if (e.type === 'done' && !e.payload.ok) out.push({ ...e, type: 'status', payload: { state: 'cancelled', detail: INTERRUPTED_DETAIL } });
    else out.push(e);
  }
  return out;
}
