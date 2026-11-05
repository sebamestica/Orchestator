// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { BootScreen } from '../../src/ui/components/BootScreen.tsx';
import { BOOT_AGENTS, bootLabelHtml } from '../../src/shared/boot-animation.ts';

afterEach(cleanup);

describe('pantalla de espera de la interfaz', () => {
  it('muestra la constelación con los colores del tema y anuncia el estado', () => {
    render(<BootScreen label="Conectando con el núcleo…" />);
    const status = screen.getByRole('status', { name: 'Conectando con el núcleo…' });
    expect(status.style.getPropertyValue('--boot-ink')).toBe('var(--foreground)');
    expect(status.querySelector('.boot.boot--settled')).toBeTruthy();
    expect(status.querySelectorAll('.boot-node')).toHaveLength(BOOT_AGENTS);
    expect(status.querySelector('.boot-label')?.textContent).toBe('Conectando con el núcleo...');
    expect(status.querySelector('style')?.textContent).toContain('@keyframes boot-spin');
  });

  it('escapa la etiqueta y, sin settled, muestra la entrada completa', () => {
    render(<BootScreen label={'<img src=x onerror=alert(1)>…'} settled={false} />);
    const status = screen.getByRole('status');
    expect(status.querySelector('img')).toBeNull();
    expect(status.querySelector('.boot--settled')).toBeNull();
    expect(bootLabelHtml('Esperando...')).toContain('Esperando<span class="boot-dots"');
  });
});
