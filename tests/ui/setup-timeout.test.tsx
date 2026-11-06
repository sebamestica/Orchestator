// @vitest-environment happy-dom
import { cleanup, getConfig, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  cleanup();
});

/** Muestra el elemento a los 1500 ms: más que el tope por defecto de Testing Library (1000 ms). */
function TardeAparece() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(id);
  }, []);
  return visible ? <span data-testid="tarde" /> : null;
}

describe('tope de espera de las pruebas de la interfaz', () => {
  it('tests/ui/setup.ts sube asyncUtilTimeout a 15 s', () => {
    expect(getConfig().asyncUtilTimeout).toBe(15_000);
  });

  it('findBy espera un elemento que tarda 1500 ms en aparecer', async () => {
    render(<TardeAparece />);
    expect(await screen.findByTestId('tarde')).toBeTruthy();
  });

  it('el tope explícito se respeta y un elemento que no aparece sigue fallando', async () => {
    await expect(screen.findByTestId('no-existe', {}, { timeout: 50 })).rejects.toThrow();
  });
});
