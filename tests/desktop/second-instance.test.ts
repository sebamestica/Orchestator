import { describe, expect, it } from 'vitest';
import { onSecondInstance } from '../../apps/desktop/src/lib/second-instance.ts';

describe('reabrir Berland', () => {
  it('durante el cierre no muestra la ventana que se está cerrando: pide abrir otra al terminar', () => {
    expect(onSecondInstance({ shuttingDown: true })).toBe('reopen-after-close');
  });

  it('con la ventana abierta la trae al frente', () => {
    expect(onSecondInstance({ shuttingDown: false })).toBe('show');
  });
});
