/** Utilidades de las pruebas de ajustes: núcleo falso por `fetch` y datos de ejemplo. */
import { vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api.ts';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import type { AgentRecord } from '../../../src/ui/api/types.ts';
import { useApp } from '../../../src/ui/store/app.ts';

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: Call) => { status?: number; body: unknown };

/** Instala un `fetch` falso: `routes` se busca por `"MÉTODO /ruta"`; lo que falte responde 404. */
export function fakeCore(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  setCoreEndpoint({ url: 'http://core', wsUrl: 'ws://core/ws', token: 'token-de-prueba' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const raw = typeof init?.body === 'string' ? init.body : undefined;
      const call: Call = { method, path: url.pathname, body: raw ? (JSON.parse(raw) as unknown) : undefined };
      calls.push(call);
      const handler = routes[`${method} ${url.pathname}`];
      const res = handler ? handler(call) : { status: 404, body: { error: { code: 'not_found', message: 'No existe' } } };
      return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

export function agent(id: string, over: Partial<AgentRecord['config']> = {}): AgentRecord {
  return {
    config: { id, kind: 'claude-sdk', provider: 'anthropic', displayName: id, quotaFloor: 0.2, enabled: true, ...over },
    quotaMethod: null,
    lastProbe: null,
    createdAt: '2026-11-04T10:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
  };
}

export function resetStore(over: { agents?: AgentRecord[]; settings?: Settings } = {}): void {
  useApp.setState({ agents: over.agents ?? [], projects: [], settings: over.settings ?? DEFAULT_SETTINGS });
}

/** Responde a `PATCH /settings` aplicando el cambio a los ajustes actuales (un nivel, como el núcleo). */
export function patchSettings(call: Call): { body: { settings: Settings } } {
  const cur = useApp.getState().settings;
  const p = call.body as Partial<{ mind: Record<string, unknown>; mindLimits: Record<string, unknown>; appearance: Record<string, unknown> }> & Record<string, unknown>;
  const mind: Record<string, unknown> = { ...cur.mind, ...(p.mind ?? {}) };
  if (mind.model === null) delete mind.model;
  const mindLimits = { ...cur.mindLimits, ...(p.mindLimits ?? {}) };
  return { body: { settings: { ...cur, ...p, mind, mindLimits, appearance: { ...cur.appearance, ...(p.appearance ?? {}) } } as Settings } };
}
