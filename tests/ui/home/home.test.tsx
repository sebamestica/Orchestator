// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeView } from '../../../src/ui/features/home/HomeView.tsx';
import { useApp } from '../../../src/ui/store/app.ts';

describe('HomeView', () => {
  afterEach(() => cleanup());

  it('«Darle una tarea a mano» lleva al Tablero pidiendo abrir el diálogo', () => {
    window.history.replaceState(null, '', '/#/');
    useApp.setState({ projects: [] });
    render(<HomeView />);
    fireEvent.click(screen.getByText('Darle una tarea a mano'));
    expect(window.location.hash).toBe('#/tablero?nueva');
  });
});
