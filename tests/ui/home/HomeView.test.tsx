// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord, TaskRecord } from '../../../src/ui/api/types.ts';
import { HomeView } from '../../../src/ui/features/home/HomeView.tsx';
import { useApp } from '../../../src/ui/store/app.ts';
import { fakeCore, resetStore } from '../settings/helpers.ts';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function project(id: string, createdAt: string): ProjectRecord {
  return { id, name: `Proyecto ${id}`, repoPath: `C:/dev/${id}`, createdAt };
}

function task(projectId: string, updatedAt: string): TaskRecord {
  return {
    state: 'running',
    planId: null,
    agentId: null,
    detail: null,
    attempts: 0,
    createdAt: updatedAt,
    updatedAt,
    lastEventAt: null,
    task: {
      id: `t-${projectId}`,
      projectId,
      title: `Tarea de ${projectId}`,
      objective: 'Objetivo',
      ownedPaths: ['src/a.ts'],
      dependsOn: [],
      acceptance: ['Criterio'],
      difficulty: 'low',
      contextRefs: [],
      skillRefs: [],
    },
  };
}

/** Nombres de los proyectos de «Retoma donde quedaste», en el orden en que salen. */
function listedNames(): string[] {
  return screen.getAllByRole('link').map((a) => a.querySelector('span')?.textContent ?? '');
}

function rowOf(name: string): HTMLElement {
  const row = screen.getAllByRole('link').find((a) => a.textContent?.includes(name));
  if (!row) throw new Error(`No está la fila de ${name}`);
  return row;
}

describe('HomeView: «Retoma donde quedaste»', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('ordena por último uso y lo muestra: un chat reciente sube a un proyecto antiguo', async () => {
    resetStore();
    useApp.setState({ projects: [project('A', ago(7 * 24 * HOUR)), project('B', ago(30 * HOUR))], tasks: {} });
    fakeCore({
      'GET /chats': () => ({ body: { chats: [{ projectId: 'A', updatedAt: ago(5 * 60_000) }] } }),
    });

    render(<HomeView />);

    await waitFor(() => expect(listedNames()).toEqual(['Proyecto A', 'Proyecto B']));
    expect(rowOf('Proyecto A').textContent).toContain('Hoy');
    expect(rowOf('Proyecto B').textContent).toContain('Ayer');
  });

  it('un proyecto antiguo con una tarea reciente entra en la lista aunque haya 6 más nuevos', async () => {
    resetStore();
    const projects = [project('viejo', ago(30 * 24 * HOUR))];
    for (let d = 1; d <= 6; d++) projects.push(project(`nuevo${d}`, ago(d * 24 * HOUR + HOUR)));
    useApp.setState({ projects, tasks: { 't-viejo': task('viejo', ago(10 * 60_000)) } });
    fakeCore({ 'GET /chats': () => ({ body: { chats: [] } }) });

    render(<HomeView />);

    await waitFor(() => expect(listedNames()[0]).toBe('Proyecto viejo'));
    expect(listedNames()).toHaveLength(6);
    expect(rowOf('Proyecto viejo').textContent).toContain('Hoy');
  });
});
