// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Effort } from '../../../src/shared/api.ts';
import { EFFORT_HINTS, EFFORT_LABELS, EffortSlider } from '../../../src/ui/components/EffortSlider.tsx';

afterEach(() => {
  cleanup();
});

function StatefulEffortSlider(props: {
  initialValue?: Effort;
  levels?: readonly Effort[];
  isDisabled?: boolean;
  onChange?: (val: Effort) => void;
}) {
  const [value, setValue] = useState<Effort>(props.initialValue ?? 'medium');
  return (
    <EffortSlider
      value={value}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
      levels={props.levels}
      isDisabled={props.isDisabled}
    />
  );
}

describe('EffortSlider', () => {
  it("renderiza con value 'medium', abre el panel, flecha derecha → onChange('high') y muestra «Profundo»", async () => {
    const onChange = vi.fn();
    render(<StatefulEffortSlider initialValue="medium" onChange={onChange} />);

    // 1. Botón disparador muestra «Esfuerzo: Equilibrado»
    const trigger = screen.getByRole('button', { name: /Esfuerzo: Equilibrado/i });
    expect(trigger).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    // 2. Abre el panel flotante
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Esfuerzo de razonamiento' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText('Equilibrado')).toBeTruthy();

    // 3. Slider accesible con aria-label y aria-valuetext
    const slider = within(dialog).getByRole('slider', { name: 'Esfuerzo de razonamiento' });
    expect(slider.getAttribute('aria-valuetext')).toBe('Equilibrado');

    // 4. Flecha derecha cambia a 'high' y muestra «Profundo»
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('high');
    expect(within(dialog).getByText('Profundo')).toBeTruthy();
    expect(slider.getAttribute('aria-valuetext')).toBe('Profundo');
  });

  it('flecha izquierda reduce el nivel y muestra «Rápido» con su descripción', async () => {
    const onChange = vi.fn();
    render(<StatefulEffortSlider initialValue="medium" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Esfuerzo: Equilibrado/i }));
    const dialog = await screen.findByRole('dialog');
    const slider = within(dialog).getByRole('slider', { name: 'Esfuerzo de razonamiento' });

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('low');
    expect(within(dialog).getByText('Rápido')).toBeTruthy();
    expect(within(dialog).getByText(EFFORT_HINTS.low)).toBeTruthy();
  });

  it('nivel max muestra la descripción de pensar a fondo', async () => {
    render(<StatefulEffortSlider initialValue="max" />);

    fireEvent.click(screen.getByRole('button', { name: /Esfuerzo: Máximo/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Máximo')).toBeTruthy();
    expect(within(dialog).getByText(/piensa a fondo, tarda más y gasta más/i)).toBeTruthy();

    // Flecha derecha en el extremo no sobrepasa el límite
    const slider = within(dialog).getByRole('slider', { name: 'Esfuerzo de razonamiento' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(within(dialog).getByText('Máximo')).toBeTruthy();
  });

  it('tecla Escape cierra el panel flotante', async () => {
    render(<StatefulEffortSlider initialValue="medium" />);

    const trigger = screen.getByRole('button', { name: /Esfuerzo: Equilibrado/i });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('respeta la propiedad isDisabled deshabilitando disparador y slider', () => {
    const onChange = vi.fn();
    render(<EffortSlider value="medium" onChange={onChange} isDisabled />);

    const trigger = screen.getByRole('button', { name: /Esfuerzo: Equilibrado/i });
    expect(trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('soporta lista personalizada de niveles', async () => {
    const customLevels: readonly Effort[] = ['low', 'high', 'max'];
    const onChange = vi.fn();
    render(<StatefulEffortSlider initialValue="low" levels={customLevels} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Esfuerzo: Rápido/i }));
    const dialog = await screen.findByRole('dialog');
    const slider = within(dialog).getByRole('slider');

    // Al pulsar derecha debe saltar directo a 'high' (el siguiente de customLevels)
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('high');
    expect(within(dialog).getByText(EFFORT_LABELS.high)).toBeTruthy();
  });
});
