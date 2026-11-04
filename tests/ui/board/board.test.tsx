// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import type { AgentRecord, ProjectRecord, TaskRecord } from '../../../src/ui/api/types.ts';
import BoardView from '../../../src/ui/features/board/BoardView.tsx';
import { useApp } from '../../../src/ui/store/app.ts';

const mockProjects: ProjectRecord[] = [
  {
    id: 'proj-alpha',
    name: 'Proyecto Alfa',
    repoPath: 'C:/dev/alpha',
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  {
    id: 'proj-beta',
    name: 'Proyecto Beta',
    repoPath: 'C:/dev/beta',
    createdAt: '2026-11-02T10:00:00.000Z',
  },
];

const mockAgents: AgentRecord[] = [
  {
    config: {
      id: 'claude-1',
      displayName: 'Claude Orquestador',
      kind: 'claude-sdk',
      provider: 'anthropic',
      quotaFloor: 0.2,
      enabled: true,
    },
    quotaMethod: null,
    lastProbe: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  },
  {
    config: {
      id: 'codex-1',
      displayName: 'Codex CLI',
      kind: 'codex-cli',
      provider: 'codex',
      quotaFloor: 0.2,
      enabled: true,
    },
    quotaMethod: null,
    lastProbe: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  },
];

function makeTask(
  id: string,
  projectId: string,
  state: TaskRecord['state'],
  title: string,
  extra: Partial<TaskRecord['task']> = {},
  agentId: string | null = null,
): TaskRecord {
  return {
    state,
    planId: 'plan-123',
    agentId,
    createdAt: '2026-11-04T08:00:00.000Z',
    updatedAt: '2026-11-04T09:30:00.000Z',
    task: {
      id,
      projectId,
      title,
      objective: `Objetivo detallado de ${id}`,
      ownedPaths: ['src/core/a.ts', 'src/core/b.ts', 'src/core/c.ts'],
      dependsOn: [],
      acceptance: ['Criterio 1', 'Criterio 2'],
      difficulty: 'medium',
      suggestedAgent: 'claude-1',
      contextRefs: [],
      skillRefs: [],
      ...extra,
    },
  };
}

describe('BoardView', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let refreshTasksMock: ReturnType<typeof vi.fn<() => Promise<void>>>;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setCoreEndpoint({ url: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: 'test-token' });
    refreshTasksMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const tasksMap: Record<string, TaskRecord> = {
      't-pending-1': makeTask('t-pending-1', 'proj-alpha', 'pending', 'Tarea pendiente Alfa', {
        ownedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        difficulty: 'low',
      }),
      't-ready-1': makeTask('t-ready-1', 'proj-alpha', 'ready', 'Tarea lista Alfa', { difficulty: 'medium' }),
      't-running-1': makeTask('t-running-1', 'proj-alpha', 'running', 'Tarea en curso Alfa', { difficulty: 'high' }),
      't-handed-1': makeTask('t-handed-1', 'proj-alpha', 'handed_off', 'Tarea traspasada Alfa', { difficulty: 'medium' }),
      't-review-1': makeTask('t-review-1', 'proj-alpha', 'review', 'Tarea en revisión Alfa', { difficulty: 'low' }),
      't-integrated-1': makeTask('t-integrated-1', 'proj-alpha', 'integrated', 'Tarea integrada Alfa', { difficulty: 'low' }),
      't-failed-1': makeTask('t-failed-1', 'proj-alpha', 'failed', 'Tarea fallida Alfa', { difficulty: 'high' }),
      't-cancelled-1': makeTask('t-cancelled-1', 'proj-alpha', 'cancelled', 'Tarea cancelada Alfa', { difficulty: 'low' }),
      't-pending-beta': makeTask('t-pending-beta', 'proj-beta', 'pending', 'Tarea pendiente Beta', { difficulty: 'medium' }),
    };

    useApp.setState({
      projects: mockProjects,
      agents: mockAgents,
      tasks: tasksMap,
      refreshTasks: refreshTasksMock,
    });

    mockFetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/tasks/manual')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ task: tasksMap['t-pending-1'] }),
        });
      }
      if (u.includes('/approve')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ task: { ...tasksMap['t-pending-1'], state: 'ready' } }),
        });
      }
      if (u.includes('/cancel')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ task: { ...tasksMap['t-running-1'], state: 'cancelled' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });
    });

    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it('agrupa por estado con contadores exactos e incluye handed_off en «En curso» con marca', () => {
    render(<BoardView />);

    // Verificar las 7 columnas y sus contadores
    const pendingSection = screen.getByLabelText('Columna Pendiente');
    expect(pendingSection.textContent).toContain('2'); // t-pending-1 y t-pending-beta

    const readySection = screen.getByLabelText('Columna Lista');
    expect(readySection.textContent).toContain('1'); // t-ready-1

    const runningSection = screen.getByLabelText('Columna En curso');
    expect(runningSection.textContent).toContain('2'); // t-running-1 y t-handed-1 (handed_off)

    const reviewSection = screen.getByLabelText('Columna Revisión');
    expect(reviewSection.textContent).toContain('1'); // t-review-1

    const integratedSection = screen.getByLabelText('Columna Integrada');
    expect(integratedSection.textContent).toContain('1'); // t-integrated-1

    const failedSection = screen.getByLabelText('Columna Fallida');
    expect(failedSection.textContent).toContain('1'); // t-failed-1

    const cancelledSection = screen.getByLabelText('Columna Cancelada');
    expect(cancelledSection.textContent).toContain('1'); // t-cancelled-1

    // Verificar que la tarea traspasada tiene la marca «Traspasada»
    expect(screen.getByText('Traspasada')).toBeTruthy();

    // Verificar que la tarjeta t-pending-1 muestra sus rutas y +1
    const card = screen.getByLabelText(/Tarea t-pending-1/i);
    expect(within(card).getByText('src/a.ts')).toBeTruthy();
    expect(within(card).getByText('src/b.ts')).toBeTruthy();
    expect(within(card).getByText('+1')).toBeTruthy();
  });

  it('filtra por proyecto cuando se pasa projectId fijo por prop', () => {
    render(<BoardView projectId="proj-beta" />);

    // Solo debe verse la tarea de Beta
    expect(screen.getByText('Tarea pendiente Beta')).toBeTruthy();
    expect(screen.queryByText('Tarea pendiente Alfa')).toBeNull();

    // La columna Pendiente ahora tiene contador 1
    const pendingSection = screen.getByLabelText('Columna Pendiente');
    expect(pendingSection.textContent).toContain('1');

    // Las otras columnas no tienen tareas para Beta
    const readySection = screen.getByLabelText('Columna Lista');
    expect(readySection.textContent).toContain('0');
  });

  it('filtra por proyecto usando el selector en el encabezado', () => {
    render(<BoardView />);

    // Inicialmente se ven ambas
    expect(screen.getByText('Tarea pendiente Alfa')).toBeTruthy();
    expect(screen.getByText('Tarea pendiente Beta')).toBeTruthy();

    // Abrir el selector de proyectos
    const selectTrigger = screen.getByRole('button', { name: /elegir proyecto para filtrar/i });
    fireEvent.click(selectTrigger);

    // Seleccionar Proyecto Beta
    const betaOption = screen.getByRole('option', { name: 'Proyecto Beta' });
    fireEvent.click(betaOption);

    // Ahora solo se ve Beta
    expect(screen.getByText('Tarea pendiente Beta')).toBeTruthy();
    expect(screen.queryByText('Tarea pendiente Alfa')).toBeNull();
  });

  it('muestra EmptyState si no hay tareas para el filtro', () => {
    useApp.setState({ tasks: {} });
    render(<BoardView />);

    expect(screen.getByText('No hay tareas')).toBeTruthy();
    expect(screen.getByText('No hay ninguna tarea registrada en el tablero.')).toBeTruthy();
  });

  it('abre el modal de detalle y permite Aprobar una tarea pendiente llamando a POST /tasks/:id/approve', async () => {
    render(<BoardView />);

    // Clic en la tarjeta de t-pending-1
    const card = screen.getByLabelText(/Tarea t-pending-1/i);
    fireEvent.click(card);

    // Modal abierto: verificar detalles
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Tarea pendiente Alfa' })).toBeTruthy();
    expect(within(dialog).getByText('Objetivo detallado de t-pending-1')).toBeTruthy();
    expect(within(dialog).getByText('Criterio 1')).toBeTruthy();
    expect(within(dialog).getByText('src/a.ts')).toBeTruthy();

    // Seleccionar un agente para asignar
    const agentSelect = within(dialog).getByLabelText('Asignar agente');
    fireEvent.change(agentSelect, { target: { value: 'codex-1' } });

    // Clic en Aprobar
    const approveBtn = within(dialog).getByRole('button', { name: /aprobar tarea/i });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:47811/tasks/t-pending-1/approve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ agentId: 'codex-1' }),
        }),
      );
      expect(refreshTasksMock).toHaveBeenCalled();
    });
  });

  it('permite Cancelar una tarea en curso llamando a POST /tasks/:id/cancel', async () => {
    render(<BoardView />);

    // Clic en la tarjeta de t-running-1
    const card = screen.getByLabelText(/Tarea t-running-1/i);
    fireEvent.click(card);

    // Modal abierto
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Tarea en curso Alfa' })).toBeTruthy();

    // En estado running no hay botón de Aprobar, pero sí de Cancelar
    expect(within(dialog).queryByRole('button', { name: /aprobar tarea/i })).toBeNull();
    const cancelBtn = within(dialog).getByRole('button', { name: /cancelar tarea/i });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:47811/tasks/t-running-1/cancel',
        expect.objectContaining({
          method: 'POST',
        }),
      );
      expect(refreshTasksMock).toHaveBeenCalled();
    });
  });

  it('muestra aviso claro si la ruta de aprobar o cancelar responde con error 404 o 501', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 501,
      text: async () => JSON.stringify({ error: { code: 'not_implemented', message: 'Ruta aún no implementada' } }),
    });

    render(<BoardView />);

    const card = screen.getByLabelText(/Tarea t-pending-1/i);
    fireEvent.click(card);

    const approveBtn = screen.getByRole('button', { name: /aprobar tarea/i });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText(/Error 501/i)).toBeTruthy();
      expect(screen.getByText(/Ruta aún no implementada/i)).toBeTruthy();
    });
  });

  it('el diálogo de tarea a mano valida campos vacíos', () => {
    render(<BoardView />);

    // Abrir diálogo
    const openBtn = screen.getByRole('button', { name: /abrir diálogo de tarea a mano/i });
    fireEvent.click(openBtn);

    expect(screen.getByText('Nueva tarea a mano')).toBeTruthy();

    // Intentar enviar con campos vacíos
    const submitBtn = screen.getByRole('button', { name: /crear tarea manual/i });
    fireEvent.click(submitBtn);

    // Debe mostrar error de título
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('El título es obligatorio.')).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();

    // Llenar título pero dejar objetivo vacío
    const titleInput = screen.getByLabelText('Título');
    fireEvent.change(titleInput, { target: { value: 'Mi tarea' } });
    fireEvent.click(submitBtn);

    expect(screen.getByText('El objetivo es obligatorio.')).toBeTruthy();

    // Llenar objetivo pero dejar rutas vacías
    const objInput = screen.getByLabelText('Objetivo');
    fireEvent.change(objInput, { target: { value: 'Objetivo de prueba' } });
    fireEvent.click(submitBtn);

    expect(screen.getByText('Debes indicar al menos una ruta propia.')).toBeTruthy();
  });

  it('el diálogo de tarea a mano envía el cuerpo correcto a /tasks/manual, cierra y refresca', async () => {
    render(<BoardView />);

    const openBtn = screen.getByRole('button', { name: /abrir diálogo de tarea a mano/i });
    fireEvent.click(openBtn);

    const projectSelect = screen.getByLabelText('Proyecto');
    fireEvent.change(projectSelect, { target: { value: 'proj-alpha' } });

    const titleInput = screen.getByLabelText('Título');
    fireEvent.change(titleInput, { target: { value: 'Refactorizar módulo X' } });

    const objInput = screen.getByLabelText('Objetivo');
    fireEvent.change(objInput, { target: { value: 'Mejorar cobertura y tipos' } });

    const pathsInput = screen.getByLabelText('Rutas propias');
    fireEvent.change(pathsInput, { target: { value: 'src/mod/x.ts\ntests/mod/x.test.ts' } });

    const critInput = screen.getByLabelText('Criterios de aceptación');
    fireEvent.change(critInput, { target: { value: '100% tipos\nTest pasando' } });

    const agentSelect = screen.getByLabelText('Agente');
    fireEvent.change(agentSelect, { target: { value: 'codex-1' } });

    const submitBtn = screen.getByRole('button', { name: /crear tarea manual/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:47811/tasks/manual',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            projectId: 'proj-alpha',
            title: 'Refactorizar módulo X',
            objective: 'Mejorar cobertura y tipos',
            ownedPaths: ['src/mod/x.ts', 'tests/mod/x.test.ts'],
            acceptance: ['100% tipos', 'Test pasando'],
            approve: true,
            agentId: 'codex-1',
          }),
        }),
      );
      expect(refreshTasksMock).toHaveBeenCalled();
    });
  });
});
