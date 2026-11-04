// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentsPanel } from '../../../src/ui/features/agents-panel/AgentsPanel.tsx';
import { applyEvents, initialView } from '../../../src/ui/features/agents-panel/model.ts';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import type { LiveMessage } from '../../../src/ui/api/live.ts';
import type { AgentEvent, SessionRecord } from '../../../src/ui/api/types.ts';
import { useApp } from '../../../src/ui/store/app.ts';

const live = vi.hoisted(() => ({ listeners: new Set<(message: LiveMessage) => void>(), replay: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../../src/ui/api/live.ts', () => ({ getLive: () => live }));
const ts = '2026-11-04T12:00:00.000Z';
const session = (id = 'parent', parentSessionId: string | null = null): SessionRecord => ({ id, agentId: 'claude', taskId: 'task-1', parentSessionId, state: 'running', startedAt: ts, updatedAt: ts, endedAt: null, lastSeq: -1 });
const text = (seq: number, sessionId = 'parent'): AgentEvent => ({ sessionId, agentId: 'claude', seq, ts, type: 'text', payload: { text: `Mensaje ${seq}`, role: 'assistant' } });
let sessions: SessionRecord[];
let frames: FrameRequestCallback[];
let fetchMock: ReturnType<typeof vi.fn>;
async function send(message: LiveMessage) {
  await act(async () => {
    for (const listener of live.listeners) listener(message);
    const callbacks = frames.splice(0);
    for (const callback of callbacks) callback(0);
  });
}
beforeEach(() => {
  sessions = [session()];
  frames = [];
  live.listeners.clear();
  live.replay.mockReset();
  live.subscribe.mockReset().mockImplementation((listener: (message: LiveMessage) => void) => {
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  setCoreEndpoint({ url: 'http://127.0.0.1:47811', wsUrl: 'ws://127.0.0.1:47811/ws', token: 'test-token' });
  useApp.setState({ core: 'ready', live: 'open', agents: [{ config: { id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Mi Claude', model: 'modelo-prueba', quotaFloor: 0.2, enabled: true }, quotaMethod: null, lastProbe: null, createdAt: ts, updatedAt: ts }], quotas: {} });
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/sessions') ? { sessions } : { rows: [{ day: new Date().toISOString().slice(0, 10), costUsd: 2 }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agentes en vivo', () => {
  it('muestra tarjetas de /sessions, resumen y pide historial al abrir', async () => {
    render(<AgentsPanel />);
    expect(await screen.findByText('Mi Claude')).toBeTruthy();
    expect(screen.getByText('modelo-prueba')).toBeTruthy();
    expect(screen.getByText('Tarea task-1')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/sessions?limit=50'))).toBe(true);
    expect(live.listeners.size).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Expandir sesión parent' }));
    expect(live.replay).toHaveBeenCalledWith('parent', -1);
  });
  it('agrupa texto en vivo por cuadro y lo muestra en su tarjeta', async () => {
    render(<AgentsPanel />);
    await screen.findByText('Mi Claude');
    act(() => { for (const listener of live.listeners) { listener({ type: 'event', event: text(0) }); listener({ type: 'event', event: text(1) }); } });
    expect(frames).toHaveLength(1);
    expect(screen.queryByText('Mensaje 0')).toBeNull();
    await send({ type: 'pong' });
    expect(within(screen.getByRole('article', { name: 'Sesión parent' })).getByText('Mensaje 1')).toBeTruthy();
  });
  it('suma usage sin duplicar replay y conserva consumo fuera de los 500 eventos', async () => {
    render(<AgentsPanel />);
    await screen.findByText('Mi Claude');
    const usage: AgentEvent = { ...text(0), type: 'usage', payload: { inputTokens: 10, outputTokens: 3, costUsd: 0.25 } };
    await send({ type: 'event', event: usage });
    await send({ type: 'event', event: { ...usage, seq: 1 } });
    await send({ type: 'replay', sessionId: 'parent', events: [usage], lastSeq: 0, hasMore: false });
    expect(screen.getByText('Entrada 20 · Salida 6')).toBeTruthy();
    expect(screen.getByText(/0,50/)).toBeTruthy();
  });
  it('anida sesiones bajo parentSessionId con consumo propio', async () => {
    sessions.push(session('child', 'parent'));
    render(<AgentsPanel />);
    const child = await screen.findByRole('article', { name: 'Sesión child' });
    expect(child.closest('details')?.querySelector('summary')?.textContent).toBe('Subagentes (1)');
    await send({ type: 'event', event: { ...text(0, 'child'), parentSessionId: 'parent', type: 'usage', payload: { inputTokens: 7, outputTokens: 2 } } });
    expect(within(child).getByText('Entrada 7 · Salida 2')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Sesión parent' })).getByText('Entrada 0 · Salida 0')).toBeTruthy();
  });
  it('elige el bucket de menor remainingFraction y su reinicio', async () => {
    useApp.setState({ quotas: { claude: { recordedAt: ts, snapshot: { agentId: 'claude', method: 'manual-budget', takenAt: ts, stale: false, buckets: [
      { groupId: 'a', groupName: 'Diario', window: 'daily', remainingFraction: 0.8 },
      { groupId: 'b', groupName: 'Semanal', window: 'weekly', remainingFraction: 0.15, resetAt: ts },
      { groupId: 'c', groupName: 'Sin dato', window: 'total', remainingFraction: null },
    ] } } } });
    render(<AgentsPanel />);
    const progress = await screen.findByRole('progressbar');
    expect(progress.getAttribute('aria-valuenow')).toBe('15');
    expect(screen.getByText(`Reinicia ${new Date(ts).toLocaleString('es-CL')}`)).toBeTruthy();
  });
  it('recorta la transmisión a 500 eventos en memoria y en la vista expandida', async () => {
    const events = Array.from({ length: 510 }, (_, index) => text(index));
    const state = applyEvents({ parent: initialView(session()) }, events);
    expect(state.parent?.events).toHaveLength(500);
    expect(state.parent?.events[0]?.seq).toBe(10);
    render(<AgentsPanel />);
    await screen.findByText('Mi Claude');
    await send({ type: 'replay', sessionId: 'parent', events, lastSeq: 509, hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: 'Expandir sesión parent' }));
    expect(screen.queryByText('Mensaje 9')).toBeNull();
    expect(screen.getByText('Mensaje 10')).toBeTruthy();
    expect(screen.getByLabelText('Transmisión parent').children).toHaveLength(500);
    expect(live.replay).toHaveBeenLastCalledWith('parent', 509);
  });
  it.each([404, 501])('avisa si la ruta devuelve %s', async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Pendiente' } }), { status }));
    render(<AgentsPanel />);
    expect((await screen.findByRole('status')).textContent).toContain('todavía no están disponibles');
  });
  it('conserva eventos anteriores cuando el replay llega después del vivo y descarta datos inválidos', () => {
    let state = applyEvents({}, [text(5)]);
    const untouched = initialView(session('other'));
    state.other = untouched;
    state = applyEvents(state, [text(0), text(5), { invalid: true }]);
    expect(state.parent?.events.map((event) => event.seq)).toEqual([0, 5]);
    expect(state.other).toBe(untouched);
  });
  it('mantiene el consumo y la deduplicación después de recortar eventos antiguos', () => {
    const usage: AgentEvent = { ...text(0), type: 'usage', payload: { inputTokens: 10, outputTokens: 4, costUsd: 0.3 } };
    let state = applyEvents({}, [usage, ...Array.from({ length: 510 }, (_, index) => text(index + 1))]);
    state = applyEvents(state, [usage]);
    expect(state.parent?.events).toHaveLength(500);
    expect(state.parent?.input).toBe(10);
    expect(state.parent?.cost).toBe(0.3);
  });
  it('muestra herramientas, resultados y archivos como chips y continúa el replay', async () => {
    render(<AgentsPanel />);
    await screen.findByText('Mi Claude');
    const events: AgentEvent[] = [
      { ...text(0), type: 'tool_call', payload: { callId: 'call', name: 'terminal', inputSummary: 'npm test' } },
      { ...text(1), type: 'tool_result', payload: { callId: 'call', ok: true, summary: 'Pruebas listas' } },
      { ...text(2), type: 'file_change', payload: { path: 'src/panel.tsx', change: 'modify' } },
    ];
    await send({ type: 'replay', sessionId: 'parent', events, lastSeq: 2, hasMore: true });
    expect(screen.getByText('terminal · npm test')).toBeTruthy();
    expect(screen.getByText('Pruebas listas')).toBeTruthy();
    expect(screen.getByText('~ src/panel.tsx')).toBeTruthy();
    expect(live.replay).toHaveBeenLastCalledWith('parent', 2);
  });
  it('pliega terminadas en Recientes y libera el listener al desmontar', async () => {
    sessions = [{ ...session(), state: 'done' }];
    const { unmount } = render(<AgentsPanel />);
    await waitFor(() => expect(screen.getByText('Recientes (1)')).toBeTruthy());
    expect(screen.getByRole('article').closest('details')?.open).toBe(false);
    unmount();
    expect(live.listeners.size).toBe(0);
  });
});

