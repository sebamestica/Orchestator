// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, effortSchema, mindModeSchema, type MindCandidate } from '../../../src/shared/api.ts';
import { EFFORT_LABELS } from '../../../src/ui/components/EffortSlider.tsx';
import { MODE_INFO } from '../../../src/ui/features/chat/format.ts';
import SettingsView from '../../../src/ui/features/settings/SettingsView.tsx';
import { useApp } from '../../../src/ui/store/app.ts';
import { agent, fakeCore, patchSettings, resetStore } from './helpers.ts';

const candidates: MindCandidate[] = [
  { agentId: 'claude-main', displayName: 'Claude principal', kind: 'claude-sdk', support: 'full', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  { agentId: 'claude-b', displayName: 'Claude B', kind: 'claude-sdk', support: 'full', models: ['claude-haiku-5-5'] },
  { agentId: 'codex', displayName: 'Codex', kind: 'codex-cli', support: 'experimental', note: 'Falta el puente MCP por HTTP.', models: [] },
  { agentId: 'gpt-api', displayName: 'GPT por API', kind: 'api', support: 'none', note: 'Sin herramientas.', models: [] },
];

beforeEach(() => {
  resetStore({ agents: [agent('claude-main'), agent('claude-b'), agent('codex', { kind: 'codex-cli', provider: 'codex' }), agent('apagado', { enabled: false })] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Mente y subagentes', () => {
  it('cambiar la mente envía PATCH /settings con el agente y borra el modelo', async () => {
    const calls = fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }), 'PATCH /settings': patchSettings });
    render(<SettingsView section="mente" />);
    const group = await screen.findByRole('radiogroup', { name: 'Mente' });
    // Con `agentId: null` la elegida es la primera con soporte completo.
    expect(within(group).getByRole('radio', { name: 'Claude principal' }).getAttribute('aria-checked')).toBe('true');
    expect((within(group).getByRole('radio', { name: 'GPT por API' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Falta el puente MCP por HTTP.')).toBeTruthy();

    fireEvent.click(within(group).getByRole('radio', { name: 'Claude B' }));
    await waitFor(() => expect(useApp.getState().settings.mind.agentId).toBe('claude-b'));
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/settings', body: { mind: { agentId: 'claude-b', model: null } } }]);
  });

  it('elegir el modelo envía PATCH /settings con mind.model', async () => {
    const calls = fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }), 'PATCH /settings': patchSettings });
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, mind: { agentId: 'claude-main', effort: 'high' } } });
    render(<SettingsView section="mente" />);
    await screen.findByRole('radiogroup', { name: 'Mente' });
    const trigger = screen.getAllByRole('button').find((b) => b.getAttribute('aria-haspopup') === 'listbox');
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger as HTMLElement);
    fireEvent.click(await screen.findByRole('option', { name: 'claude-sonnet-5-5' }));
    await waitFor(() => expect(useApp.getState().settings.mind.model).toBe('claude-sonnet-5-5'));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ mind: { model: 'claude-sonnet-5-5' } }]);
  });

  it('el esfuerzo y el modo inicial se guardan', async () => {
    const calls = fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }), 'PATCH /settings': patchSettings });
    render(<SettingsView section="mente" />);
    await screen.findByRole('radiogroup', { name: 'Mente' });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Esfuerzo' })).getByRole('radio', { name: 'Máximo' }));
    await waitFor(() => expect(useApp.getState().settings.mind.effort).toBe('max'));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Modo inicial' })).getByRole('radio', { name: /Bypass/ }));
    await waitFor(() => expect(useApp.getState().settings.defaultMode).toBe('bypass'));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ mind: { effort: 'max' } }, { defaultMode: 'bypass' }]);
  });

  it('Ajustes › Mente nombra el esfuerzo como la barra del chat', async () => {
    fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }) });
    render(<SettingsView section="mente" />);
    await screen.findByRole('radiogroup', { name: 'Mente' });
    const group = screen.getByRole('radiogroup', { name: 'Esfuerzo' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(effortSchema.options.map((e) => EFFORT_LABELS[e]));
    expect(useApp.getState().settings.mind.effort).toBe('medium');
    expect(within(group).getByRole('radio', { name: 'Equilibrado' }).getAttribute('aria-checked')).toBe('true');
    expect(within(group).queryByRole('radio', { name: 'Medio' })).toBeNull();
  });

  it('la descripción de Bypass avisa que edita y ejecuta sin preguntar', async () => {
    fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }) });
    render(<SettingsView section="mente" />);
    await screen.findByRole('radiogroup', { name: 'Mente' });
    const text = within(screen.getByRole('radiogroup', { name: 'Modo inicial' })).getByRole('radio', { name: /Bypass/ }).textContent ?? '';
    expect(text).toMatch(/edita/i);
    expect(text).toMatch(/comandos/i);
    expect(text).toMatch(/sin preguntar/i);
    expect(text.replace(/^Bypass/, '')).not.toMatch(/^Como Auto/);
  });

  it('el modo inicial ofrece los cuatro modos y guarda «Chat»', async () => {
    const calls = fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }), 'PATCH /settings': patchSettings });
    render(<SettingsView section="mente" />);
    await screen.findByRole('radiogroup', { name: 'Mente' });
    const group = screen.getByRole('radiogroup', { name: 'Modo inicial' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(mindModeSchema.options.length);
    mindModeSchema.options.forEach((m, i) => expect(radios[i]?.textContent).toBe(`${MODE_INFO[m].label}${MODE_INFO[m].description}`));
    fireEvent.click(within(group).getByRole('radio', { name: /^Chat/ }));
    await waitFor(() => expect(useApp.getState().settings.defaultMode).toBe('chat'));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ defaultMode: 'chat' }]);
  });

  it('con defaultMode «chat» la opción Chat sale marcada', async () => {
    fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }) });
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, defaultMode: 'chat' } });
    render(<SettingsView section="mente" />);
    await screen.findByRole('radiogroup', { name: 'Mente' });
    const group = screen.getByRole('radiogroup', { name: 'Modo inicial' });
    const chat = within(group).getByRole('radio', { name: /^Chat/ });
    expect(chat.getAttribute('aria-checked')).toBe('true');
    for (const r of within(group).getAllByRole('radio')) if (r !== chat) expect(r.getAttribute('aria-checked'), r.textContent ?? '').toBe('false');
  });

  it('los interruptores de subagentes arman workers (todos activos = [])', async () => {
    const calls = fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates } }), 'PATCH /settings': patchSettings });
    render(<SettingsView section="mente" />);
    await screen.findByRole('radiogroup', { name: 'Mente' });
    // Solo los habilitados tienen interruptor; con workers [] todos están activos.
    expect(screen.queryByRole('switch', { name: /apagado/ })).toBeNull();
    const codex = screen.getByRole('switch', { name: /^codex/ });
    expect((codex as HTMLInputElement).checked).toBe(true);

    fireEvent.click(codex);
    await waitFor(() => expect(useApp.getState().settings.workers).toEqual(['claude-b', 'claude-main']));
    expect((screen.getByRole('switch', { name: /^codex/ }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('switch', { name: /^claude-b/ }));
    await waitFor(() => expect(useApp.getState().settings.workers).toEqual(['claude-main']));
    // El último activo no se puede apagar (workers vacío significaría «todos»).
    expect((screen.getByRole('switch', { name: /^claude-main/ }) as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: /^codex/ }));
    fireEvent.click(await screen.findByRole('switch', { name: /^claude-b/ }));
    await waitFor(() => expect(useApp.getState().settings.workers).toEqual([]));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { workers: ['claude-b', 'claude-main'] },
      { workers: ['claude-main'] },
      { workers: ['claude-main', 'codex'] },
      { workers: [] },
    ]);
  });

  it('sin la ruta de candidatos muestra un aviso y sigue mostrando subagentes', async () => {
    fakeCore({});
    render(<SettingsView section="mente" />);
    expect(await screen.findByText(/aún no lista candidatos/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: /^codex/ })).toBeTruthy();
  });

  it('una lista de candidatos inválida muestra un aviso en vez de quedarse cargando', async () => {
    fakeCore({ 'GET /mind/candidates': () => ({ body: { candidates: [{ agentId: 'x', support: 'quizá' }] } }) });
    render(<SettingsView section="mente" />);
    expect(await screen.findByText(/formato inesperado/)).toBeTruthy();
    expect(screen.queryByText(/Cargando candidatos/)).toBeNull();
    expect(screen.getByRole('switch', { name: /^codex/ })).toBeTruthy();
  });
});

describe('General', () => {
  it('guarda el tema y «Menos efectos»', async () => {
    const calls = fakeCore({ 'PATCH /settings': patchSettings });
    render(<SettingsView section="general" />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Tema' })).getByRole('radio', { name: 'Claro' }));
    await waitFor(() => expect(useApp.getState().settings.appearance.theme).toBe('light'));
    fireEvent.click(screen.getByRole('switch', { name: /Menos efectos/ }));
    await waitFor(() => expect(useApp.getState().settings.appearance.reducedEffects).toBe(true));
    expect(calls.map((c) => c.body)).toEqual([{ appearance: { theme: 'light' } }, { appearance: { reducedEffects: true } }]);
  });

  it('guarda concurrencia y umbral de cupo en fracción', async () => {
    const calls = fakeCore({ 'PATCH /settings': patchSettings });
    render(<SettingsView section="general" />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Concurrencia' })).getByRole('radio', { name: '5' }));
    await waitFor(() => expect(useApp.getState().settings.concurrency).toBe(5));
    const floor = screen.getByLabelText('Umbral de cupo en porcentaje');
    fireEvent.change(floor, { target: { value: '35' } });
    fireEvent.blur(floor);
    await waitFor(() => expect(useApp.getState().settings.quotaFloor).toBe(0.35));
    expect(calls.map((c) => c.body)).toEqual([{ concurrency: 5 }, { quotaFloor: 0.35 }]);
  });

  it('si el núcleo no tiene /settings avisa sin romperse', async () => {
    fakeCore({});
    render(<SettingsView section="general" />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Tema' })).getByRole('radio', { name: 'Claro' }));
    expect(await screen.findByText(/todavía no tiene esta función/)).toBeTruthy();
    expect(useApp.getState().settings.appearance.theme).toBe('dark');
  });
});

describe('navegación', () => {
  it('enlaza cada sección y marca la activa', () => {
    fakeCore({});
    render(<SettingsView section="general" />);
    const nav = screen.getByRole('navigation', { name: 'Secciones de ajustes' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['#/ajustes/general', '#/ajustes/mente', '#/ajustes/agentes', '#/ajustes/proyectos', '#/ajustes/memoria', '#/ajustes/skills', '#/ajustes/uso', '#/ajustes/almacenamiento']);
    expect(within(nav).getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBe('page');
  });
});
