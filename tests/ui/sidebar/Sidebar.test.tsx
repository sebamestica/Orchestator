// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../../src/ui/app/Sidebar.tsx';
import type { ProjectRecord } from '../../../src/ui/api/types.ts';
import { useApp } from '../../../src/ui/store/app.ts';
import { fakeCore, resetStore } from '../settings/helpers.ts';

const vetworld: ProjectRecord = { id: 'vetworld', name: 'Vetworld', repoPath: 'C:\\dev\\Vetworld', createdAt: '2026-11-04T10:00:00.000Z' };
const orquestador: ProjectRecord = { id: 'orquestador', name: 'Orquestador', repoPath: 'C:\\dev\\orquestador', createdAt: '2026-11-03T10:00:00.000Z' };

beforeEach(() => {
  resetStore();
  useApp.setState({ projects: [vetworld, orquestador] });
  window.history.replaceState(null, '', '/#/p/vetworld');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openMenu() {
  fireEvent.click(screen.getByLabelText('Opciones de Vetworld'));
  return screen.findByRole('dialog', { name: 'Opciones de Vetworld' });
}

describe('Barra lateral: opciones de un proyecto', () => {
  it('«…» abre un menú de ese proyecto sin salir de su chat', async () => {
    fakeCore({});
    render(<Sidebar route={{ name: 'project', projectId: 'vetworld' }} />);
    const menu = await openMenu();
    expect(within(menu).getByRole('button', { name: 'Quitar…' })).toBeTruthy();
    expect(within(menu).getByRole('link', { name: 'Ver en Ajustes' }).getAttribute('href')).toBe('#/ajustes/proyectos');
    expect(window.location.hash).toBe('#/p/vetworld');
    expect(screen.getByRole('link', { name: 'Vetworld' }).getAttribute('aria-current')).toBe('page');
  });

  it('«Quitar…» confirma y llama a DELETE solo para ese proyecto', async () => {
    const calls = fakeCore({
      'DELETE /projects/vetworld': () => ({ body: { deleted: true, id: 'vetworld' } }),
      'GET /projects': () => ({ body: { projects: [orquestador] } }),
    });
    render(<Sidebar route={{ name: 'project', projectId: 'vetworld' }} />);
    fireEvent.click(within(await openMenu()).getByRole('button', { name: 'Quitar…' }));
    const confirm = await screen.findByRole('dialog', { name: '¿Quitar Vetworld?' });
    expect(within(confirm).getByText(/no toca la carpeta/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Quitar' }));
    await waitFor(() => expect(useApp.getState().projects).toEqual([orquestador]));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /projects/vetworld', 'GET /projects']);
  });

  it('quitar el proyecto abierto vuelve a la portada; quitar otro no cambia la ruta', async () => {
    fakeCore({
      'DELETE /projects/vetworld': () => ({ body: { deleted: true, id: 'vetworld' } }),
      'DELETE /projects/orquestador': () => ({ body: { deleted: true, id: 'orquestador' } }),
      'GET /projects': () => ({ body: { projects: [] } }),
    });
    const remove = async (name: string) => {
      fireEvent.click(screen.getByLabelText(`Opciones de ${name}`));
      fireEvent.click(within(await screen.findByRole('dialog', { name: `Opciones de ${name}` })).getByRole('button', { name: 'Quitar…' }));
      fireEvent.click(within(await screen.findByRole('dialog', { name: `¿Quitar ${name}?` })).getByRole('button', { name: 'Quitar' }));
    };
    const view = render(<Sidebar route={{ name: 'project', projectId: 'vetworld' }} />);
    await remove('Orquestador');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '¿Quitar Orquestador?' })).toBeNull());
    expect(window.location.hash).toBe('#/p/vetworld');
    view.unmount();
    useApp.setState({ projects: [vetworld] });
    render(<Sidebar route={{ name: 'project', projectId: 'vetworld' }} />);
    await remove('Vetworld');
    await waitFor(() => expect(window.location.hash).toBe('#/'));
  });
});
