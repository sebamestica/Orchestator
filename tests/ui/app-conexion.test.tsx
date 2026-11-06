// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreEndpoint } from '../../src/ui/api/bridge.ts';
import { App } from '../../src/ui/app/App.tsx';
import { useApp } from '../../src/ui/store/app.ts';

const bridge = vi.hoisted(() => ({ resolveCore: vi.fn<() => Promise<CoreEndpoint | null>>() }));
vi.mock('../../src/ui/api/bridge.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/api/bridge.ts')>()),
  resolveCore: bridge.resolveCore,
}));
vi.mock('../../src/ui/api/live.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/api/live.ts')>()),
  startLive: () => ({ onStatus: () => () => undefined, subscribe: () => () => undefined, stop: () => undefined }),
}));
// Lo que rodea a la pantalla de conexión no importa aquí: se reemplaza por marcas simples.
vi.mock('../../src/ui/features/home/HomeView.tsx', () => ({ HomeView: () => <p>portada</p> }));
vi.mock('../../src/ui/features/agents-panel/AgentsPanel.tsx', () => ({ AgentsPanel: () => null }));
vi.mock('../../src/ui/app/Sidebar.tsx', () => ({ Sidebar: () => null }));
vi.mock('../../src/ui/app/TitleBar.tsx', () => ({ TitleBar: () => null }));

const core: CoreEndpoint = { url: '', wsUrl: 'ws://127.0.0.1/ws', token: 'test' };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const empty: Record<string, unknown> = { '/projects': { projects: [] }, '/agents': { agents: [] }, '/tasks': { tasks: [] } };

beforeEach(() => {
  useApp.setState({ core: 'starting', coreError: null });
  bridge.resolveCore.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('pantalla sin conexión con el núcleo', () => {
  it('sin token: nombra Berland y el enlace «web:», sin «Reintentar»', async () => {
    bridge.resolveCore.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByText('Sin conexión con el núcleo')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Berland');
    expect(text).toContain('«web:»');
    expect(text).not.toContain('el orquestador');
    expect(text).not.toContain('Abrir en el navegador');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
  });

  it('si el núcleo falla, «Reintentar» vuelve a conectar y pasa a la portada', async () => {
    bridge.resolveCore.mockResolvedValue(core);
    let projectCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/projects' && ++projectCalls === 1) return Promise.resolve(reply({ error: { message: 'núcleo caído' } }, 503));
        return Promise.resolve(url in empty ? reply(empty[url]) : reply({}, 404));
      }),
    );
    render(<App />);
    expect(await screen.findByText('El núcleo no responde')).toBeTruthy();
    expect(screen.getByText('núcleo caído')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('portada')).toBeTruthy();
    expect(bridge.resolveCore).toHaveBeenCalledTimes(2);
    expect(projectCalls).toBe(2);
  });
});
