// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsView from '../../../src/ui/features/settings/SettingsView.tsx';
import { useApp } from '../../../src/ui/store/app.ts';
import { agent, fakeCore, resetStore } from './helpers.ts';

const SECRET = 'sk-ant-prueba-0123456789';

beforeEach(() => {
  resetStore({ agents: [agent('claude-main', { displayName: 'Claude principal', budgetUsd: 20 }), agent('codex', { kind: 'codex-cli', provider: 'codex', displayName: 'Codex' })] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Agentes', () => {
  it('agregar por clave envía POST /agents y limpia la clave', async () => {
    const added = agent('claude-nuevo', { displayName: 'Mi Claude' });
    const calls = fakeCore({ 'POST /agents': () => ({ status: 201, body: { agent: added, probe: null } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar por clave/ }));
    const dialog = await screen.findByRole('dialog');
    const key = within(dialog).getByLabelText('Clave de API') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: SECRET } });
    fireEvent.change(within(dialog).getByLabelText('Nombre'), { target: { value: 'Mi Claude' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar' }));

    await waitFor(() => expect(useApp.getState().agents.some((a) => a.config.id === 'claude-nuevo')).toBe(true));
    expect(calls).toEqual([{ method: 'POST', path: '/agents', body: { provider: 'anthropic', apiKey: SECRET, displayName: 'Mi Claude' } }]);
    expect(key.value).toBe('');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // La clave no queda en ningún lado de la interfaz.
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(JSON.stringify(useApp.getState())).not.toContain(SECRET);
  });

  it('si el alta falla, la clave también se borra y se muestra el error', async () => {
    fakeCore({ 'POST /agents': () => ({ status: 422, body: { error: { code: 'probe_failed', message: 'La clave no funciona.' } } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar por clave/ }));
    const dialog = await screen.findByRole('dialog');
    const key = within(dialog).getByLabelText('Clave de API') as HTMLInputElement;
    fireEvent.change(key, { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar' }));
    expect(await within(dialog).findByText(/La clave no funciona/)).toBeTruthy();
    expect(key.value).toBe('');
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('avisa si la URL base es http:// y la exige para openai-compatible', async () => {
    const calls = fakeCore({});
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar por clave/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Compatible con OpenAI' }));
    fireEvent.change(within(dialog).getByLabelText('Clave de API'), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar' }));
    expect(await within(dialog).findByText(/URL base es obligatoria/)).toBeTruthy();
    expect(calls).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('URL base'), { target: { value: 'http://192.168.1.5:8000/v1' } });
    expect(within(dialog).getByText(/sin cifrar/)).toBeTruthy();
  });

  it('probar llama a POST /agents/:id/probe y muestra el resultado', async () => {
    const probed = { ...agent('codex', { kind: 'codex-cli', provider: 'codex', displayName: 'Codex' }), lastProbe: { agentId: 'codex', installed: true, authenticated: true, version: '0.130.0', models: ['gpt-5.5'], quotaMethod: 'codex-ratelimits' as const, warnings: [] } };
    const calls = fakeCore({ 'POST /agents/codex/probe': () => ({ body: { agent: probed, probe: probed.lastProbe } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: 'Probar Codex' }));
    expect(await screen.findByText(/Versión 0.130.0/)).toBeTruthy();
    expect(screen.getByText('Funciona')).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /agents/codex/probe']);
  });

  it('borrar pide confirmación y llama a DELETE /agents/:id', async () => {
    const calls = fakeCore({ 'DELETE /agents/codex': () => ({ body: { deleted: true, id: 'codex' } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: 'Borrar Codex' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar' }));
    await waitFor(() => expect(useApp.getState().agents.map((a) => a.config.id)).toEqual(['claude-main']));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /agents/codex']);
  });

  it('habilitar y presupuesto envían PATCH /agents/:id', async () => {
    const calls = fakeCore({
      'PATCH /agents/codex': (c) => ({ body: { agent: agent('codex', { kind: 'codex-cli', provider: 'codex', displayName: 'Codex', ...(c.body as object) }) } }),
      'PATCH /agents/claude-main': (c) => ({ body: { agent: agent('claude-main', { displayName: 'Claude principal', ...(c.body as object) }) } }),
    });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Habilitar Codex' }));
    await waitFor(() => expect(useApp.getState().agents.find((a) => a.config.id === 'codex')?.config.enabled).toBe(false));
    // El presupuesto solo aparece en claude-sdk.
    expect(screen.queryByLabelText('Presupuesto en USD de Codex')).toBeNull();
    const budget = screen.getByLabelText('Presupuesto en USD de Claude principal');
    fireEvent.change(budget, { target: { value: '35' } });
    fireEvent.blur(budget);
    await waitFor(() => expect(useApp.getState().agents.find((a) => a.config.id === 'claude-main')?.config.budgetUsd).toBe(35));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/agents/codex', { enabled: false }],
      ['/agents/claude-main', { budgetUsd: 35 }],
    ]);
  });

  it('detectar CLIs agrega los nuevos', async () => {
    const agy = agent('agy', { kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity' });
    fakeCore({ 'POST /agents/detect': () => ({ body: { detected: [{ id: 'agy', kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity', executable: 'agy', argsPrefix: [] }], added: [agy] } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: /Detectar CLIs/ }));
    expect(await screen.findByText(/1 CLI\(s\) detectado\(s\), 1 nuevo/)).toBeTruthy();
    expect(useApp.getState().agents.some((a) => a.config.id === 'agy')).toBe(true);
  });
});

describe('Agentes: respuestas inválidas del núcleo', () => {
  const ids = () => useApp.getState().agents.map((a) => a.config.id).sort();

  it('alta: avisa y no toca el store', async () => {
    fakeCore({ 'POST /agents': () => ({ status: 201, body: { agent: { config: { id: 'x' } }, probe: null } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar por clave/ }));
    const dialog = await screen.findByRole('dialog');
    const key = within(dialog).getByLabelText('Clave de API') as HTMLInputElement;
    fireEvent.change(key, { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar' }));
    expect(await within(dialog).findByText(/el agente nuevo con un formato inesperado/)).toBeTruthy();
    expect(ids()).toEqual(['claude-main', 'codex']);
    expect(key.value).toBe('');
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('detección: avisa y no agrega nada', async () => {
    fakeCore({ 'POST /agents/detect': () => ({ body: { detected: 'mal', added: [{ nada: true }] } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: /Detectar CLIs/ }));
    expect(await screen.findByText(/la detección de CLIs con un formato inesperado/)).toBeTruthy();
    expect(ids()).toEqual(['claude-main', 'codex']);
  });

  it('prueba: avisa y conserva el agente', async () => {
    const before = useApp.getState().agents.find((a) => a.config.id === 'codex');
    fakeCore({ 'POST /agents/codex/probe': () => ({ body: { agent: null, probe: { installed: 'sí' } } }) });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('button', { name: 'Probar Codex' }));
    expect(await screen.findByText(/la prueba del agente con un formato inesperado/)).toBeTruthy();
    expect(useApp.getState().agents.find((a) => a.config.id === 'codex')).toBe(before);
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('edición: avisa y conserva habilitado y presupuesto', async () => {
    fakeCore({
      'PATCH /agents/codex': () => ({ body: { agent: { config: { id: 'codex', enabled: 'no' } } } }),
      'PATCH /agents/claude-main': () => ({ body: {} }),
    });
    render(<SettingsView section="agentes" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Habilitar Codex' }));
    expect(await screen.findByText(/el agente editado con un formato inesperado/)).toBeTruthy();
    expect(useApp.getState().agents.find((a) => a.config.id === 'codex')?.config.enabled).toBe(true);
    const budget = screen.getByLabelText('Presupuesto en USD de Claude principal');
    fireEvent.change(budget, { target: { value: '35' } });
    fireEvent.blur(budget);
    await waitFor(() => expect(screen.getAllByText(/el agente editado con un formato inesperado/)).toHaveLength(2));
    expect(useApp.getState().agents.find((a) => a.config.id === 'claude-main')?.config.budgetUsd).toBe(20);
  });
});

describe('Proyectos', () => {
  it('quitar confirma que no toca la carpeta y llama a DELETE /projects/:id', async () => {
    useApp.setState({ projects: [{ id: 'vetworld', name: 'Vetworld', repoPath: 'C:\\dev\\Vetworld', createdAt: '2026-11-04T10:00:00.000Z' }] });
    const calls = fakeCore({ 'DELETE /projects/vetworld': () => ({ body: { deleted: true, id: 'vetworld' } }), 'GET /projects': () => ({ body: { projects: [] } }) });
    render(<SettingsView section="proyectos" />);
    expect(screen.getByText(/Sin gate/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Quitar/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/no toca la carpeta/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Quitar' }));
    await waitFor(() => expect(useApp.getState().projects).toEqual([]));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /projects/vetworld', 'GET /projects']);
  });
});

describe('Memoria', () => {
  it('muestra el contexto del proyecto con sus caracteres', async () => {
    useApp.setState({ projects: [{ id: 'vetworld', name: 'Vetworld', repoPath: 'C:\\dev\\Vetworld', createdAt: '2026-11-04T10:00:00.000Z' }] });
    fakeCore({ 'GET /memory/vetworld/context': () => ({ body: { projectId: 'vetworld', taskId: null, budgetChars: 4000, chars: 12, context: '# Vetworld\nok' } }) });
    render(<SettingsView section="memoria" />);
    expect(await screen.findByText(/# Vetworld/)).toBeTruthy();
    expect(screen.getByText(/12 de/)).toBeTruthy();
  });

  it('una respuesta inválida muestra un aviso en vez de quedarse cargando', async () => {
    useApp.setState({ projects: [{ id: 'vetworld', name: 'Vetworld', repoPath: 'C:\\dev\\Vetworld', createdAt: '2026-11-04T10:00:00.000Z' }] });
    fakeCore({ 'GET /memory/vetworld/context': () => ({ body: { projectId: 'vetworld', chars: 'muchos' } }) });
    render(<SettingsView section="memoria" />);
    expect(await screen.findByText(/formato inesperado/)).toBeTruthy();
    expect(screen.queryByText(/Cargando/)).toBeNull();
  });
});

describe('Skills', () => {
  it('lista, importa a cuarentena y aprueba', async () => {
    let installed = [{ name: 'redaccion', folder: 'redaccion', root: 'C:\\skills', description: 'Escribe bien', valid: true, problems: [] }];
    const calls = fakeCore({
      'GET /skills': () => ({ body: { skills: installed } }),
      'POST /skills/import': () => ({ status: 201, body: { result: { id: 'pdf-20261104-105000-abc123', name: 'pdf', description: 'Lee PDFs', fileCount: 3, scripts: [{ path: 'run.sh', reasons: ['extensión'] }], warnings: [], license: { files: [] } } } }),
      'POST /skills/pdf-20261104-105000-abc123/approve': () => {
        installed = [...installed, { name: 'pdf', folder: 'pdf', root: 'C:\\skills', description: 'Lee PDFs', valid: true, problems: [] }];
        return { body: { result: {} } };
      },
    });
    render(<SettingsView section="skills" />);
    expect(await screen.findByText('redaccion')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ruta de la skill'), { target: { value: 'C:\\Descargas\\pdf.zip' } });
    fireEvent.click(screen.getByRole('button', { name: /Importar/ }));
    expect(await screen.findByText(/Ejecutables: run.sh/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Aprobar/ }));
    expect(await screen.findByText(/«pdf» instalada/)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /skills', 'POST /skills/import', 'POST /skills/pdf-20261104-105000-abc123/approve', 'GET /skills']);
    expect(calls[1]?.body).toEqual({ source: 'C:\\Descargas\\pdf.zip' });
  });

  it('sin hub de skills (501) avisa', async () => {
    fakeCore({ 'GET /skills': () => ({ status: 501, body: { error: { code: 'not_configured', message: 'No configurado' } } }) });
    render(<SettingsView section="skills" />);
    expect(await screen.findByText(/todavía no tiene esta función/)).toBeTruthy();
  });
});
