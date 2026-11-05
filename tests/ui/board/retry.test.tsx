// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import { lastActivity } from '../../../src/ui/api/tasks.ts';
import type { TaskRecord } from '../../../src/ui/api/types.ts';
import BoardView from '../../../src/ui/features/board/BoardView.tsx';
import { useApp } from '../../../src/ui/store/app.ts';

function makeTask(id: string, state: TaskRecord['state'], extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    state,
    planId: null,
    agentId: 'codex',
    detail: null,
    attempts: 1,
    createdAt: '2026-11-04T18:00:00.000Z',
    updatedAt: '2026-11-04T18:06:00.000Z',
    lastEventAt: null,
    task: {
      id,
      projectId: 'marketing',
      title: `Tarea ${id}`,
      objective: `Objetivo de ${id}`,
      ownedPaths: ['guiones/**'],
      dependsOn: [],
      acceptance: ['Criterio'],
      difficulty: 'medium',
      contextRefs: [],
      skillRefs: [],
    },
    ...extra,
  };
}

const MOTIVO = 'nucleo-almacenamiento-local: sin éxito tras 4 intentos (último: timeout (Sin actividad del agente durante 60 min))';

describe('Reintentar tareas fallidas en el tablero', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let refreshTasks: ReturnType<typeof vi.fn<() => Promise<void>>>;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setCoreEndpoint({ url: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: 'test-token' });
    refreshTasks = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const failed = makeTask('fallida', 'failed', { detail: MOTIVO, attempts: 3 });
    useApp.setState({
      projects: [{ id: 'marketing', name: 'Marketing', repoPath: 'C:/dev/marketing', createdAt: '2026-11-01T10:00:00.000Z' }],
      agents: [],
      tasks: {
        fallida: failed,
        corriendo: makeTask('corriendo', 'running', { detail: 'continúa claude en el mismo worktree' }),
        integrada: makeTask('integrada', 'integrated'),
        cancelada: makeTask('cancelada', 'cancelled', { detail: 'Ya no hace falta' }),
      },
      refreshTasks,
    });
    mockFetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ task: { ...failed, state: String(url).includes('/retry') ? 'ready' : failed.state } }),
      }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it('la tarjeta muestra el motivo y «Reintentar» solo en tareas fallidas', () => {
    render(<BoardView />);
    const failedColumn = screen.getByLabelText('Columna Fallida');
    expect(within(failedColumn).getByText(MOTIVO)).toBeTruthy();
    expect(within(failedColumn).getByRole('button', { name: 'Reintentar tarea fallida' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Reintentar tarea/ })).toHaveLength(1);
    // El motivo de otros estados no se muestra en la tarjeta.
    expect(screen.queryByText('continúa claude en el mismo worktree')).toBeNull();
    expect(screen.queryByText('Ya no hace falta')).toBeNull();
  });

  it('«Reintentar» en la tarjeta llama a POST /tasks/:id/retry sin abrir el detalle y refresca', async () => {
    render(<BoardView />);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar tarea fallida' }));
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:47811/tasks/fallida/retry', expect.objectContaining({ method: 'POST' }));
      expect(refreshTasks).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('si el núcleo responde 409, la tarjeta muestra el aviso', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: { code: 'conflict', message: 'La tarea fallida depende de base (failed)' } }),
    });
    render(<BoardView />);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar tarea fallida' }));
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toMatch(/Error 409 \(conflict\) al reintentar la tarea: La tarea fallida depende de base/);
    });
    expect(refreshTasks).not.toHaveBeenCalled();
  });

  it('el detalle de una fallida muestra por qué se detuvo, los intentos y el botón; reintentar cierra y refresca', async () => {
    render(<BoardView />);
    fireEvent.click(screen.getByLabelText(/Tarea fallida: Tarea fallida/));
    const dialog = screen.getByRole('dialog');
    const motive = within(dialog).getByLabelText('Motivo del fallo');
    expect(within(motive).getByText('Por qué se detuvo')).toBeTruthy();
    expect(within(motive).getByText(MOTIVO)).toBeTruthy();
    expect(within(dialog).getByText('Intentos: 3')).toBeTruthy();
    // Una fallida no se cancela ni se aprueba: se reintenta.
    expect(within(dialog).queryByRole('button', { name: /cancelar tarea/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reintentar tarea' }));
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:47811/tasks/fallida/retry', expect.objectContaining({ method: 'POST' }));
      expect(refreshTasks).toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('el detalle de una tarea que no falló no tiene motivo de fallo ni botón de reintento', () => {
    render(<BoardView />);
    fireEvent.click(screen.getByLabelText(/Tarea corriendo/));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Motivo del fallo')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Reintentar tarea' })).toBeNull();
  });

  it('el avance se ve aunque el estado no cambie: la hora mostrada es la del último evento', () => {
    expect(lastActivity({ createdAt: '2026-11-04T18:00:00.000Z', updatedAt: '2026-11-04T18:06:00.000Z', lastEventAt: '2026-11-04T23:39:00.000Z' })).toBe(
      '2026-11-04T23:39:00.000Z',
    );
    expect(lastActivity({ createdAt: '2026-11-04T18:00:00.000Z', updatedAt: '2026-11-04T18:06:00.000Z', lastEventAt: null })).toBe('2026-11-04T18:06:00.000Z');
    useApp.setState({
      tasks: { viva: makeTask('viva', 'running', { updatedAt: '2020-01-01T00:00:00.000Z', lastEventAt: new Date().toISOString() }) },
    });
    render(<BoardView />);
    const card = screen.getByLabelText(/Tarea viva/);
    expect(within(card).getByText('Ahora')).toBeTruthy();
  });
});
