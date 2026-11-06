// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddProjectDialog } from '../../../src/ui/features/projects/AddProjectDialog.tsx';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import { useApp } from '../../../src/ui/store/app.ts';
import type { DesktopBridge } from '../../../src/shared/api.ts';

vi.mock('../../../src/ui/api/live.ts', () => ({ getLive: () => null }));
const inspection = { path: 'C:/dev/demo', suggestedId: 'demo', suggestedName: 'Demo', isGitRepo: true, gate: [{ command: 'npm', args: ['run', '-s', 'check'] }], links: [], warnings: ['Revisa el gate'] };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const refresh = vi.fn().mockResolvedValue(undefined);
function desktop(pickFolder: DesktopBridge['pickFolder']): DesktopBridge {
  return { platform: 'win32', core: vi.fn(), pickFolder, pathForFile: () => null, openExternal: vi.fn(), window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() } };
}
beforeEach(() => {
  setCoreEndpoint({ url: '', wsUrl: '', token: 'test' });
  useApp.setState({ refreshProjects: refresh }); refresh.mockClear();
  window.location.hash = '';
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.orq; });
describe('Abrir carpeta', () => {
  it('elige con el puente, inspecciona y registra con nombre editable', async () => {
    const pick = vi.fn().mockResolvedValue(inspection.path); window.orq = desktop(pick);
    vi.mocked(fetch).mockResolvedValueOnce(reply(inspection)).mockResolvedValueOnce(reply({ project: { id: 'demo' } }));
    const close = vi.fn(); render(<AddProjectDialog open onClose={close} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir carpeta' }));
    const name = await screen.findByLabelText('Nombre');
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Repositorio git')).toBeTruthy();
    expect(screen.getByText('Revisa el gate')).toBeTruthy();
    // El gate detectado se muestra como texto: el núcleo guarda el que detecta él, así que no se ofrece editarlo.
    expect(screen.queryByRole('textbox', { name: /gate/i })).toBeNull();
    expect(screen.getByText('npm run -s check')).toBeTruthy();
    expect(screen.queryByText(/aún no se guardan/)).toBeNull();
    fireEvent.change(name, { target: { value: 'Mi proyecto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(window.location.hash).toBe('#/p/demo'));
    expect(fetch).toHaveBeenCalledWith('/projects/from-folder', expect.objectContaining({ body: JSON.stringify({ path: inspection.path, name: 'Mi proyecto', id: 'demo' }) }));
    expect(refresh).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });
  it('sin gate detectado avisa del modo local y no sugiere un gate', async () => {
    window.orq = desktop(vi.fn().mockResolvedValue(inspection.path));
    vi.mocked(fetch).mockResolvedValueOnce(reply({ ...inspection, gate: null }));
    render(<AddProjectDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir carpeta' }));
    await screen.findByLabelText('Nombre');
    expect(screen.getByText('Sin gate: se trabajará en local')).toBeTruthy();
    expect(screen.queryByText('npm run -s check')).toBeNull();
    expect(screen.queryByPlaceholderText('npm run -s check')).toBeNull();
  });
  it('elige carpeta en web mediante /fs/pick-folder', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply({ path: inspection.path })).mockResolvedValueOnce(reply(inspection));
    render(<AddProjectDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir carpeta' }));
    await screen.findByLabelText('Nombre');
    expect(fetch).toHaveBeenCalledWith('/fs/pick-folder', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenCalledWith('/projects/inspect', expect.objectContaining({ body: JSON.stringify({ path: inspection.path }) }));
  });
  it('explora, entra, sube e inspecciona la carpeta actual', async () => {
    const root = { path: 'C:/dev', parent: null, entries: [{ name: 'demo', path: inspection.path, isDir: true, isGitRepo: true }] };
    const child = { path: inspection.path, parent: 'C:/dev', entries: [] };
    vi.mocked(fetch).mockResolvedValueOnce(reply(root)).mockResolvedValueOnce(reply(child)).mockResolvedValueOnce(reply(root)).mockResolvedValueOnce(reply(inspection));
    render(<AddProjectDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Explorar carpetas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Entrar en demo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Subir' }));
    await screen.findByRole('button', { name: 'Entrar en demo' });
    fireEvent.click(screen.getByRole('button', { name: 'Usar esta carpeta' }));
    await screen.findByLabelText('Nombre');
    expect(fetch).toHaveBeenCalledWith('/fs/list?path=C%3A%2Fdev%2Fdemo', expect.objectContaining({ method: 'GET' }));
  });
  it('cancelar el selector no inspecciona', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply({ path: null }));
    render(<AddProjectDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir carpeta' }));
    await waitFor(() => expect(screen.queryByLabelText('Procesando carpeta')).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([404, 501])('muestra aviso por ruta pendiente %s', async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(reply({}, status));
    render(<AddProjectDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir carpeta' }));
    expect((await screen.findByRole('alert')).textContent).toContain('todavía no está disponible');
  });
});
