// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../../src/shared/api.ts';
import { SkillsSection } from '../../../src/ui/features/settings/SkillsSection.tsx';
import { fakeCore, resetStore, type Call } from './helpers.ts';

const QUARANTINED = { id: 'pdf-20261104-105000-abc123', name: 'pdf', description: 'Lee PDFs', fileCount: 3, scripts: [], warnings: [], license: { declared: 'MIT', files: [] } };

beforeEach(() => {
  resetStore();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.orq;
});

function desktop(over: Partial<DesktopBridge>): DesktopBridge {
  return { platform: 'win32', core: vi.fn(), pickFolder: async () => null, pathForFile: () => null, openExternal: vi.fn(), window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }, ...over };
}

type Routes = Parameters<typeof fakeCore>[0];
function core(extra: Routes = {}): Call[] {
  return fakeCore({ 'GET /skills': () => ({ body: { skills: [] } }), 'GET /skills/quarantine': () => ({ body: { skills: [] } }), ...extra });
}

const sourceInput = () => screen.getByLabelText('Ruta de la skill') as HTMLInputElement;
const importButton = () => screen.getByRole('button', { name: /^Importar/ });
const isDisabled = (el: HTMLElement) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');

describe('Skills › cuarentena', () => {
  it('carga la cuarentena del núcleo al montar, la conserva al volver y la quita al rechazar', async () => {
    let pending = [QUARANTINED];
    const calls = fakeCore({
      'GET /skills': () => ({ body: { skills: [] } }),
      'GET /skills/quarantine': () => ({ body: { skills: pending } }),
      [`POST /skills/${QUARANTINED.id}/reject`]: () => {
        pending = [];
        return { body: { result: QUARANTINED.id } };
      },
    });

    const first = render(<SkillsSection />);
    expect(await screen.findByText('En cuarentena')).toBeTruthy();
    expect(screen.getByText('pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Aprobar/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Rechazar/ })).toBeTruthy();

    // Cambiar de sección desmonta la vista; al volver, la cuarentena sigue ahí.
    first.unmount();
    render(<SkillsSection />);
    expect(await screen.findByText('En cuarentena')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Rechazar/ }));
    expect(await screen.findByText(/«pdf» descartada/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('En cuarentena')).toBeNull());
    expect(calls.some((c) => c.method === 'POST' && c.path === `/skills/${QUARANTINED.id}/reject`)).toBe(true);
  });
});

describe('Skills › elegir la carpeta o el .zip', () => {
  it('«Carpeta…» en escritorio rellena la ruta con el diálogo nativo y habilita «Importar» sin importar todavía', async () => {
    window.orq = desktop({ pickFolder: async () => 'C:\\skills\\mi-skill' });
    const calls = core();
    render(<SkillsSection />);
    expect(isDisabled(importButton())).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Carpeta/ }));
    await waitFor(() => expect(sourceInput().value).toBe('C:\\skills\\mi-skill'));
    expect(isDisabled(importButton())).toBe(false);
    expect(calls.some((c) => c.path === '/skills/import')).toBe(false);
  });

  it('«Carpeta…» en la web usa POST /fs/pick-folder; cancelar no cambia el campo y un 501 avisa', async () => {
    const answers: { status?: number; body: unknown }[] = [
      { body: { path: 'C:\\skills\\web' } },
      { body: { path: null } },
      { status: 501, body: { error: { code: 'not_configured', message: 'No configurado' } } },
    ];
    const calls = core({ 'POST /fs/pick-folder': () => answers.shift() ?? { body: { path: null } } });
    render(<SkillsSection />);
    const button = screen.getByRole('button', { name: /Carpeta/ });
    fireEvent.click(button);
    await waitFor(() => expect(sourceInput().value).toBe('C:\\skills\\web'));
    fireEvent.click(button);
    await waitFor(() => expect(calls.filter((c) => c.path === '/fs/pick-folder')).toHaveLength(2));
    expect(sourceInput().value).toBe('C:\\skills\\web');
    fireEvent.click(button);
    expect(await screen.findByText(/todavía no tiene esta función/)).toBeTruthy();
    expect(sourceInput().value).toBe('C:\\skills\\web');
  });

  it('«Zip…» en escritorio toma la ruta real del archivo elegido con pathForFile', async () => {
    const pathForFile = vi.fn(() => 'C:\\Descargas\\mi-skill.zip');
    window.orq = desktop({ pathForFile });
    const calls = core();
    render(<SkillsSection />);
    fireEvent.click(screen.getByRole('button', { name: /Zip/ }));
    const file = new File(['PK'], 'mi-skill.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByLabelText('Archivo .zip de la skill'), { target: { files: [file] } });
    await waitFor(() => expect(sourceInput().value).toBe('C:\\Descargas\\mi-skill.zip'));
    expect(pathForFile).toHaveBeenCalledWith(file);
    expect(calls.some((c) => c.path === '/fs/pick-zip' || c.path === '/skills/import')).toBe(false);
  });

  it('«Zip…» en la web usa POST /fs/pick-zip', async () => {
    core({ 'POST /fs/pick-zip': () => ({ body: { path: 'C:\\Descargas\\web.zip' } }) });
    render(<SkillsSection />);
    fireEvent.click(screen.getByRole('button', { name: /Zip/ }));
    await waitFor(() => expect(sourceInput().value).toBe('C:\\Descargas\\web.zip'));
  });
});
