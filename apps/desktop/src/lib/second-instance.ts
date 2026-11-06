/**
 * Qué hacer cuando se abre Berland otra vez y esta instancia tiene el candado. Durante el cierre la ventana está por
 * cerrarse: mostrarla haría que vuelva y desaparezca sola, así que se pide abrir una instancia nueva al terminar.
 */
export function onSecondInstance(state: { shuttingDown: boolean }): 'show' | 'reopen-after-close' {
  return state.shuttingDown ? 'reopen-after-close' : 'show';
}
