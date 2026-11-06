// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { AgentsPanel } from '../../../src/ui/features/agents-panel/AgentsPanel.tsx';
import { applyEvents, initialView, mindRow, selectChat, STALE_MS, workerRow } from '../../../src/ui/features/agents-panel/model.ts';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import type { LiveMessage } from '../../../src/ui/api/live.ts';
import type { AgentEvent, SessionRecord, TaskRecord } from '../../../src/ui/api/types.ts';
import type { Chat } from '../../../src/shared/api.ts';
import { useApp } from '../../../src/ui/store/app.ts';
import { useChat } from '../../../src/ui/features/chat/store.ts';

const live = vi.hoisted(() => ({ listeners: new Set<(message: LiveMessage) => void>(), replay: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../../src/ui/api/live.ts', () => ({ getLive: () => live }));
const ts = '2026-11-04T12:00:00.000Z';
const now = Date.parse(ts);
const session = (patch: Partial<SessionRecord> = {}): SessionRecord => ({ id: 'worker-session', agentId: 'claude', taskId: 'task-1', parentSessionId: null, state: 'running', startedAt: ts, updatedAt: ts, endedAt: null, lastSeq: 8, ...patch });
const tool = (patch: Partial<AgentEvent> = {}): AgentEvent => ({ sessionId: 'worker-session', agentId: 'claude', seq: 9, ts, type: 'tool_call', payload: { callId: 'call', name: 'terminal', inputSummary: 'npm test' }, ...patch } as AgentEvent);
const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({ task: { id: 'task-1', projectId: 'project', title: 'Rehacer panel', objective: 'Panel mínimo', ownedPaths: ['src/ui'], dependsOn: [], acceptance: ['Visible'], difficulty: 'low', contextRefs: [], skillRefs: [] }, state: 'running', planId: null, agentId: 'claude', detail: null, attempts: 1, createdAt: ts, updatedAt: ts, lastEventAt: ts, ...patch });
const chat = (patch: Partial<Chat> = {}): Chat => ({ id: 'chat01', projectId: null, title: 'Chat', cwd: 'C:/dev', extraRoots: [], mode: 'plan', mindAgentId: 'claude', sessionId: 'chat-session', state: 'running', costUsd: 0, createdAt: ts, updatedAt: ts, ...patch });
let sessions: SessionRecord[];
let chats: Chat[];
let fetchMock: ReturnType<typeof vi.fn>;
function send(message: LiveMessage) {
  act(() => { for (const listener of live.listeners) listener(message); });
}
const paths = () => fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname + new URL(String(url)).search);
/** Espera a que el panel reciba la lista de `/chats`. */
async function chatsLoaded() {
  await waitFor(() => expect(paths()).toContain('/chats'));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}
beforeEach(() => {
  sessions = [session()];
  chats = [];
  live.listeners.clear();
  live.replay.mockReset();
  live.subscribe.mockReset().mockImplementation((listener: (message: LiveMessage) => void) => {
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  });
  setCoreEndpoint({ url: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: 'test-token' });
  useApp.setState({ core: 'ready', live: 'open', agents: [{ config: { id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Mi Claude', model: 'modelo-prueba', quotaFloor: 0.2, enabled: true }, quotaMethod: null, lastProbe: null, createdAt: ts, updatedAt: ts }], quotas: {}, tasks: {} });
  useChat.getState().reset();
  fetchMock = vi.fn(async (url: unknown) => new Response(JSON.stringify(new URL(String(url)).pathname === '/chats' ? { chats } : { sessions }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Panel mínimo', () => {
  it('mantiene mente y agentes libres sin consultar historial ni usage', async () => {
    render(<AgentsPanel />);
    expect(screen.getAllByRole('article').map((row) => row.getAttribute('aria-label'))).toEqual(['Mente', 'Mi Claude']);
    expect(screen.getAllByText('Libre')).toHaveLength(2);
    await chatsLoaded();
    expect(paths()).toEqual(['/chats']);
    expect(screen.queryByText('modelo-prueba')).toBeNull();
    expect(screen.queryByText(/Recientes|Hoy|Entrada/)).toBeNull();
    expect(live.replay).not.toHaveBeenCalled();
  });
  it('consulta tareas activas y solo un evento de cada sesión activa', async () => {
    useApp.setState({ tasks: { 'task-1': task() } });
    sessions.push(session({ id: 'finished', state: 'done' }));
    render(<AgentsPanel />);
    await waitFor(() => expect(live.replay).toHaveBeenCalledWith('worker-session', 7, 1));
    const urls = paths().filter((url) => url !== '/chats');
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes('/sessions?taskId=') && url.endsWith('&limit=10'))).toBe(true);
    expect(live.replay.mock.calls.some(([id]) => id === 'finished')).toBe(false);
    send({ type: 'event', event: tool({ ts: new Date().toISOString() }) });
    expect(within(screen.getByRole('article', { name: 'Mi Claude' })).getByText('Rehacer panel · autor · terminal · npm test')).toBeTruthy();
    expect(screen.getByText('Trabajando')).toBeTruthy();
  });
  it('muestra actividad de la mente y sus hijas; termina libre o en segundo plano', () => {
    useChat.setState({ activeId: 'chat01', chat: chat(), chats: [chat()] });
    render(<AgentsPanel />);
    const mente = within(screen.getByRole('article', { name: 'Mente' }));
    expect(mente.getByText('Pensando')).toBeTruthy();
    send({ type: 'event', event: tool({ sessionId: 'child', parentSessionId: 'chat-session' }) });
    expect(mente.getByText('terminal · npm test')).toBeTruthy();
    send({ type: 'chat', chat: chat({ state: 'idle', backgroundTasks: 1 }) });
    expect(mente.getByText('Trabajando en segundo plano')).toBeTruthy();
    send({ type: 'chat', chat: chat({ state: 'idle', backgroundTasks: 0 }) });
    expect(mente.getByText('Libre')).toBeTruthy();
  });
  it('en el Tablero ve el chat de un proyecto que piensa', async () => {
    chats = [chat({ projectId: 'proj-a', state: 'running' })];
    render(<AgentsPanel />);
    const mente = within(screen.getByRole('article', { name: 'Mente' }));
    await waitFor(() => expect(mente.getByText('Pensando')).toBeTruthy());
    send({ type: 'chat', chat: chat({ projectId: 'proj-a', state: 'idle' }) });
    expect(mente.getByText('Libre')).toBeTruthy();
  });
  it('al desmontar el chat no se pierde el estado', async () => {
    useChat.setState({ projectId: 'proj-a', activeId: 'chat01', chat: chat({ projectId: 'proj-a' }), chats: [chat({ projectId: 'proj-a' })] });
    chats = [chat({ projectId: 'proj-a' })];
    render(<AgentsPanel />);
    await chatsLoaded();
    act(() => useChat.getState().reset());
    expect(within(screen.getByRole('article', { name: 'Mente' })).getByText('Pensando')).toBeTruthy();
  });
  it('ve una Conversación en segundo plano desde un chat de proyecto', async () => {
    const idle = chat({ projectId: 'proj-a', state: 'idle' });
    useChat.setState({ projectId: 'proj-a', activeId: 'chat01', chat: idle, chats: [idle] });
    chats = [idle];
    render(<AgentsPanel />);
    await chatsLoaded();
    send({ type: 'chat', chat: chat({ id: 'conv01', projectId: null, sessionId: 'conv-session', state: 'idle', backgroundTasks: 1 }) });
    expect(within(screen.getByRole('article', { name: 'Mente' })).getByText('Trabajando en segundo plano')).toBeTruthy();
  });
  it('con varios chats pensando usa el abierto y deja de verlos al borrarlos', async () => {
    chats = [chat({ id: 'other1', projectId: 'proj-b', sessionId: 'other-session' }), chat()];
    useChat.setState({ activeId: 'chat01', chat: chat() });
    render(<AgentsPanel />);
    await waitFor(() => expect(paths()).toContain('/sessions/chat-session'));
    expect(paths()).not.toContain('/sessions/other-session');
    act(() => useChat.getState().reset());
    send({ type: 'chat_deleted', chatId: 'chat01' });
    await waitFor(() => expect(paths()).toContain('/sessions/other-session'));
    send({ type: 'chat_deleted', chatId: 'other1' });
    expect(within(screen.getByRole('article', { name: 'Mente' })).getByText('Libre')).toBeTruthy();
  });
  it('oculta agentes deshabilitados; las filas informan sin ser paradas de Tab', () => {
    const agent = useApp.getState().agents[0];
    if (!agent) throw new Error('falta el agente de prueba');
    const second = { ...agent, config: { ...agent.config, id: 'codex', displayName: 'Mi Codex' } };
    useApp.setState({ agents: [agent, second, { ...agent, config: { ...agent.config, id: 'disabled', displayName: 'Oculto', enabled: false } }] });
    render(<AgentsPanel />);
    expect(screen.queryByText('Oculto')).toBeNull();
    const rows = screen.getAllByRole('article');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.hasAttribute('tabindex')).toBe(false);
      expect(row.querySelector('[aria-live="polite"]')).toBeTruthy();
    }
    const aside = screen.getByRole('complementary', { name: 'Agentes en vivo' });
    const stops = [...aside.querySelectorAll('[tabindex]')].filter((el) => el.getAttribute('tabindex') !== '-1');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.getAttribute('aria-label')).toBe('Lista de agentes');
  });
  it('no anima el punto libre; las animaciones activas respetan reduced motion', () => {
    const { rerender } = render(<AgentsPanel />);
    expect(screen.getByRole('article', { name: 'Mi Claude' }).querySelector('.animate-pulse')).toBeNull();
    act(() => useChat.setState({ chat: chat() }));
    rerender(<AgentsPanel />);
    const mente = screen.getByRole('article', { name: 'Mente' });
    expect(mente.querySelector('.animate-spin')?.className).toContain('motion-reduce:animate-none');
    expect(mente.querySelector('.agent-activity')?.className).toContain('motion-reduce:animate-none');
  });
  it.each([0.1, 0.3, 0.09])('avisa solo con cupo menor de 10 %% (%s)', (fraction) => {
    useApp.setState({ quotas: { claude: { recordedAt: ts, snapshot: { agentId: 'claude', method: 'manual-budget', takenAt: ts, stale: false, buckets: [{ groupId: 'a', groupName: 'Diario', window: 'daily', remainingFraction: fraction }] } } } });
    render(<AgentsPanel />);
    expect(!!screen.queryByText(/Cupo bajo/)).toBe(fraction < 0.1);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
  it('con grupos marcados en uso, el cupo bajo de otro grupo no avisa', () => {
    const buckets = [
      { groupId: 'flash', groupName: 'Flash', window: 'daily' as const, remainingFraction: 0.6, inUse: true },
      { groupId: 'pro', groupName: 'Pro', window: 'daily' as const, remainingFraction: 0.02 },
    ];
    useApp.setState({ quotas: { claude: { recordedAt: ts, snapshot: { agentId: 'claude', method: 'manual-budget', takenAt: ts, stale: false, buckets } } } });
    render(<AgentsPanel />);
    expect(screen.queryByText(/Cupo bajo/)).toBeNull();
  });
  it('libera listeners al desmontar y avisa la desconexión', () => {
    useApp.setState({ live: 'closed' });
    const { unmount } = render(<AgentsPanel />);
    expect(screen.getByText('Sin conexión en vivo')).toBeTruthy();
    expect(live.listeners.size).toBe(1);
    unmount();
    expect(live.listeners.size).toBe(0);
  });
  it('pasa a Sin señal aunque no llegue otro evento', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    render(<AgentsPanel />);
    send({ type: 'event', event: tool() });
    expect(screen.getByText('Trabajando')).toBeTruthy();
    act(() => vi.advanceTimersByTime(STALE_MS + 15_000));
    expect(screen.getByText('Sin señal')).toBeTruthy();
  });
  it('refleja el fallo de una tarea recibido por el store sin recargar', () => {
    render(<AgentsPanel />);
    act(() => useApp.getState().applyLive({ type: 'task', task: task({ state: 'failed', detail: 'Interrumpida al reiniciar' }) }));
    expect(screen.getByText('Detenido')).toBeTruthy();
    expect(screen.getByText(/Interrumpida al reiniciar/)).toBeTruthy();
  });
});

describe('Modelo de actividad', () => {
  it('prioriza el chat abierto entre los que piensan', () => {
    const other = chat({ id: 'other1' });
    expect(selectChat([other, chat()], chat())?.id).toBe('chat01');
    expect(selectChat([other], chat({ state: 'idle' }))?.id).toBe('other1');
    expect(selectChat([chat({ state: 'idle', backgroundTasks: 1 })], chat())?.state).toBe('idle');
  });
  it('sin chat abierto ni activo no elige un chat viejo con error', () => {
    expect(selectChat([chat({ state: 'error' }), chat({ id: 'old', state: 'idle' })], null)).toBeUndefined();
  });
  it('muestra error de la mente y no revive chats cerrados por backgroundTasks', () => {
    expect(mindRow(chat({ state: 'error' }), {}, []).status).toBe('Error');
    expect(mindRow(chat({ state: 'closed', backgroundTasks: 2 }), {}, []).status).toBe('Libre');
  });
  it('distingue espera, sin señal y el detalle de la última tarea fallida', () => {
    const view = initialView(session({ state: 'waiting' }));
    expect(workerRow('claude', { s: view }, {}, now).status).toBe('En espera');
    expect(workerRow('claude', { s: view }, {}, now + STALE_MS + 1).status).toBe('Sin señal');
    expect(workerRow('claude', {}, { t: task({ state: 'failed', detail: 'Falló la verificación' }) }, now)).toMatchObject({ status: 'Detenido', line: 'Rehacer panel · autor · Falló la verificación' });
  });
  it('identifica al revisor por rol o por el sufijo de la tarea', () => {
    const explicit = initialView({ ...session(), role: 'reviewer' });
    expect(workerRow('claude', { s: explicit }, { 'task-1': task() }, now).line).toContain('· revisor ·');
    expect(workerRow('claude', { s: initialView(session({ taskId: 'task-1-revision' })) }, { 'task-1': task() }, now).line).toContain('· revisor ·');
  });
  it('ignora duplicados, replay antiguo y datos inválidos sin guardar una transmisión', () => {
    const current = applyEvents({}, [tool()]);
    const result = applyEvents(current, [tool({ seq: 8 }), tool(), { invalid: true }]);
    expect(result['worker-session']).toBe(current['worker-session']);
    expect(result['worker-session']).not.toHaveProperty('events');
  });
  it('conserva la última acción cuando llegan tokens y el estado terminal ante replay antiguo', () => {
    const usage: AgentEvent = { sessionId: 'worker-session', agentId: 'claude', ts, seq: 10, type: 'usage', payload: { inputTokens: 1, outputTokens: 1 } };
    let result = applyEvents({}, [tool(), usage]);
    expect(result['worker-session']?.action?.type).toBe('tool_call');
    result = applyEvents(result, [{ ...usage, seq: 11, type: 'done', payload: { ok: false } }, tool()]);
    expect(result['worker-session']?.session.state).toBe('failed');
  });
  it('no revive una sesión cerrada por REST al recibir un estado anterior', () => {
    const result = applyEvents({ s: initialView(session({ id: 's', state: 'cancelled', lastSeq: 20 })) }, [
      { sessionId: 's', agentId: 'claude', ts, seq: 10, type: 'status', payload: { state: 'running' } },
    ]);
    expect(result.s?.session.state).toBe('cancelled');
  });
});
