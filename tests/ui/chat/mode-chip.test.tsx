// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIND_MODE_CYCLE, mindModeSchema, nextMindMode } from '../../../src/shared/api.ts';
import { ModeChip } from '../../../src/ui/features/chat/components/ModeChip.tsx';
import { MODE_INFO } from '../../../src/ui/features/chat/format.ts';

afterEach(cleanup);

describe('modo chat en la ficha del modo', () => {
  it('el ciclo con Shift+Tab incluye chat: auto → plan → bypass → chat → auto', () => {
    expect(MIND_MODE_CYCLE).toEqual(['auto', 'plan', 'bypass', 'chat']);
    expect(mindModeSchema.options).toEqual(['plan', 'auto', 'bypass', 'chat']);
    expect(nextMindMode('bypass')).toBe('chat');
    expect(nextMindMode('chat')).toBe('auto');
    for (const mode of MIND_MODE_CYCLE) expect(MODE_INFO[mode].label.length, mode).toBeGreaterThan(0);
  });

  it('muestra «Chat» con su descripción y pasa a Auto con un clic', () => {
    const onChange = vi.fn();
    render(<ModeChip mode="chat" onChange={onChange} mind={{ name: 'Claude', model: 'claude-opus-5-5' }} />);
    const chip = screen.getByTestId('mode-chip');
    expect(chip.dataset.mode).toBe('chat');
    expect(chip.textContent).toBe('Chat');
    expect(chip.className).toContain('text-accent');
    expect(chip.getAttribute('aria-label')).toBe('Modo Chat. Cambiar a Auto (Shift+Tab)');
    expect(screen.getByText('Como Claude Code: responde y hace los cambios en la carpeta, sin flota.')).toBeTruthy();
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('desde Bypass, el siguiente es Chat', () => {
    const onChange = vi.fn();
    render(<ModeChip mode="bypass" onChange={onChange} mind={null} />);
    expect(screen.getByTestId('mode-chip').getAttribute('title')).toBe('Cambiar a Chat');
    fireEvent.click(screen.getByTestId('mode-chip'));
    expect(onChange).toHaveBeenCalledWith('chat');
  });
});
