// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageSummaryResponse, type UsageBucket, type UsagePeriod, type UsageSummary } from '../../../src/shared/api.ts';
import { parseRoute, routeHash, PROFILE_HASH } from '../../../src/ui/app/routes.ts';
import { setCoreEndpoint } from '../../../src/ui/api/client.ts';
import SettingsView from '../../../src/ui/features/settings/SettingsView.tsx';
import { formatDay, formatTokens, formatUsd, parseMultiplier } from '../../../src/ui/features/settings/usage-format.ts';
import { resetStore } from './helpers.ts';

function bucket(b: Partial<Omit<UsageBucket, 'totalTokens'>> = {}): UsageBucket {
  const f = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, costWithRateUsd: 0, entries: 0, ...b };
  return { ...f, totalTokens: f.inputTokens + f.cacheWriteTokens + f.cacheReadTokens + f.outputTokens };
}
const none = bucket();

/** Resumen como el del núcleo, con cifras reales del 2026-11-04 (Opus de la mente y del worker). */
function summaryFor(period: UsagePeriod, multiplier = 1): UsageSummary {
  const opus = bucket({ inputTokens: 9259059, cacheWriteTokens: 77719, cacheReadTokens: 45871974, outputTokens: 755319, costUsd: 66.67219, costWithRateUsd: 66.67219 * multiplier, entries: 58 });
  const sonnet = bucket({ inputTokens: 2368450, cacheReadTokens: 44706573, outputTokens: 1090013, costUsd: 21.291244, costWithRateUsd: 21.291244, entries: 3 });
  const api = bucket({ inputTokens: 11627509, cacheWriteTokens: 77719, cacheReadTokens: 90578547, outputTokens: 1845332, costUsd: 87.963434, costWithRateUsd: 66.67219 * multiplier + 21.291244, entries: 61 });
  const sub = bucket({ inputTokens: 1936306, cacheReadTokens: 40008176, outputTokens: 209999, reasoningTokens: 85216, entries: 432 });
  const days = period === 'today' ? ['2026-11-04'] : period === 'week' ? ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'] : ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
  const s: UsageSummary = {
    currency: 'USD',
    timeZone: 'America/Santiago',
    today: '2026-11-04',
    period,
    from: days[0] ?? '2026-11-04',
    to: '2026-11-04',
    periods: {
      today: { from: '2026-11-04', to: '2026-11-04', api, subscription: sub },
      week: { from: '2026-10-29', to: '2026-11-04', api: bucket({ costUsd: 90.5, costWithRateUsd: 95.25, entries: 70 }), subscription: sub },
      month: { from: '2026-11-01', to: '2026-11-04', api, subscription: sub },
    },
    totals: { api, subscription: sub },
    byModel: [
      { ...opus, billing: 'api', model: 'claude-opus-5-5', agentIds: ['claude', 'orquestador'], multiplier, withoutCost: 0 },
      { ...sonnet, billing: 'api', model: 'claude-sonnet-5-5', agentIds: ['orquestador'], multiplier: 1, withoutCost: 0 },
      { ...sub, billing: 'subscription', model: null, agentIds: ['agy', 'codex'], multiplier: 1, withoutCost: 0 },
    ],
    byDay: days.map((day) => ({ day, api: day === '2026-11-04' ? api : day === '2026-11-03' ? bucket({ costUsd: 2.5, costWithRateUsd: 3.25, entries: 4 }) : none, subscription: day === '2026-11-04' ? sub : none })),
    byRole: [
      { role: 'mind', api: bucket({ inputTokens: 5735757, cacheReadTokens: 67708621, outputTokens: 1630094, costUsd: 52.604748, costWithRateUsd: 52.604748, entries: 36 }), subscription: none },
      { role: 'reviewer', api: none, subscription: bucket({ inputTokens: 602678, cacheReadTokens: 7789696, outputTokens: 65797, entries: 11 }) },
    ],
    byProject: [
      { projectId: 'vetworld', name: 'Vetworld', api: bucket({ costUsd: 52.604748, costWithRateUsd: 52.604748, entries: 36 }), subscription: none },
      { projectId: null, name: null, api: bucket({ costUsd: 35.358686, costWithRateUsd: 35.358686, entries: 25 }), subscription: sub },
    ],
    subscriptions: [
      {
        ...bucket({ inputTokens: 1333628, cacheReadTokens: 32218480, outputTokens: 144202, reasoningTokens: 79485, entries: 421 }),
        agentId: 'agy',
        displayName: 'Antigravity (agy)',
        kind: 'agy-cli',
        models: ['gemini-3.8-flash-low'],
        quotaRemaining: 0.7926898,
        quotaTakenAt: '2026-11-05T01:38:10.355Z',
        quotaStale: false,
      },
      {
        ...bucket({ inputTokens: 602678, cacheReadTokens: 7789696, outputTokens: 65797, reasoningTokens: 5731, entries: 11 }),
        agentId: 'codex',
        displayName: 'Codex CLI',
        kind: 'codex-cli',
        models: [],
        quotaRemaining: 0.9,
        quotaTakenAt: '2026-11-05T01:37:59.854Z',
        quotaStale: true,
      },
    ],
    coverage: { withoutCacheWrite: 63, withoutCost: 0, unlinked: 451 },
  };
  return usageSummaryResponse.parse(s);
}

interface Seen {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

/** Núcleo falso: el resumen según `period` y la tarifa que se va guardando. */
function fakeUsageCore(opts: { fail?: boolean } = {}): Seen[] {
  const seen: Seen[] = [];
  let multiplier = 1;
  setCoreEndpoint({ url: 'http://core', wsUrl: 'ws://core/ws', token: 'token-de-prueba' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      seen.push({ method, path: url.pathname, search: url.searchParams, body });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (opts.fail) return json(404, { error: { code: 'not_found', message: 'No existe' } });
      if (method === 'GET' && url.pathname === '/usage/summary') return json(200, summaryFor((url.searchParams.get('period') ?? 'month') as UsagePeriod, multiplier));
      if (method === 'PATCH' && url.pathname === '/usage/rates') {
        const value = (body as { rates: Record<string, number | null> }).rates['claude-opus-5-5'];
        multiplier = value ?? 1;
        return json(200, { rates: value ? [{ model: 'claude-opus-5-5', multiplier: value, updatedAt: '2026-11-04T22:10:00.000Z' }] : [] });
      }
      return json(404, { error: { code: 'not_found', message: 'No existe' } });
    }),
  );
  return seen;
}

beforeEach(() => resetStore());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const summaries = (seen: Seen[]) => seen.filter((c) => c.path === '/usage/summary').map((c) => c.search.get('period'));

describe('Ajustes › Uso y gasto', () => {
  it('muestra los tres periodos con el estimado y con tu tarifa, las tablas y las notas', async () => {
    const seen = fakeUsageCore();
    render(<SettingsView section="uso" />);
    expect(screen.getByRole('heading', { name: 'Uso y gasto' })).toBeTruthy();
    const month = await screen.findByTestId('total-month');
    expect(month.textContent).toBe(formatUsd(66.67219 + 21.291244));
    expect(screen.getByTestId('total-week').textContent).toBe('95,25 USD');
    expect(screen.getAllByText(/estimado \(precios públicos\)/)).toHaveLength(3);
    expect(summaries(seen)).toEqual(['month']);
    // La zona horaria no se impone desde la interfaz: manda la del núcleo.
    expect(seen[0]?.search.has('tz')).toBe(false);

    const opusRow = screen.getByText('claude-opus-5-5').closest('tr') as HTMLElement;
    // Intl separa «77,7 mil» con un espacio duro; Testing Library normaliza el texto del DOM a espacios simples.
    expect(within(opusRow).getByText(formatTokens(77719).replace(/\s/g, ' '))).toBeTruthy();
    expect((within(opusRow).getByRole('textbox', { name: 'Multiplicador de claude-opus-5-5' }) as HTMLInputElement).value).toBe('1');
    // La suscripción no tiene costo en USD y muestra el cupo.
    const agyRow = screen.getByText('Antigravity (agy)').closest('tr') as HTMLElement;
    expect(within(agyRow).getByText('suscripción')).toBeTruthy();
    expect(within(agyRow).getByText('79 %')).toBeTruthy();
    expect(within(agyRow).queryByText(/USD/)).toBeNull();
    expect(within(screen.getByText('Codex CLI').closest('tr') as HTMLElement).getByText('90 % (lectura antigua)')).toBeTruthy();

    expect(screen.getByText(/5,2 \/ 26 USD por millón/)).toBeTruthy();
    expect(screen.getByText(/63 registros de la API son anteriores a separar la caché escrita/)).toBeTruthy();
    expect(screen.getByText(/451 registros no están enlazados/)).toBeTruthy();
  });

  it('cambiar el periodo pide otro resumen; «Hoy» no dibuja barras de un solo día', async () => {
    const seen = fakeUsageCore();
    render(<SettingsView section="uso" />);
    await screen.findByTestId('total-month');
    expect(screen.getByRole('list', { name: 'Gasto diario con tu tarifa' }).children).toHaveLength(4);

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Periodo' })).getByRole('radio', { name: '7 días' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Gasto diario con tu tarifa' }).children).toHaveLength(7));
    expect(screen.getByRole('listitem', { name: `${formatDay('2026-11-03')}: 3,25 USD con tu tarifa, 2,50 USD estimado` })).toBeTruthy();

    // La tarjeta del periodo también lo elige.
    fireEvent.click(screen.getByTestId('total-today').closest('button') as HTMLElement);
    await waitFor(() => expect(summaries(seen)).toEqual(['month', 'week', 'today']));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Gasto diario con tu tarifa' })).toBeNull());
    expect(screen.getByTestId('total-today').closest('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('el multiplicador se guarda con PATCH /usage/rates y el resumen se recarga con tu tarifa', async () => {
    const seen = fakeUsageCore();
    render(<SettingsView section="uso" />);
    await screen.findByTestId('total-month');
    const input = screen.getByRole('textbox', { name: 'Multiplicador de claude-opus-5-5' });
    fireEvent.change(input, { target: { value: '1,3' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('total-month').textContent).toBe(formatUsd(66.67219 * 1.3 + 21.291244)));
    expect(seen.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body])).toEqual([['/usage/rates', { rates: { 'claude-opus-5-5': 1.3 } }]]);
    // Estimado sin cambios; la fila muestra el nuevo factor.
    expect((screen.getByRole('textbox', { name: 'Multiplicador de claude-opus-5-5' }) as HTMLInputElement).value).toBe('1,3');

    // Vacío vuelve a 1 (null); un valor inválido no se envía.
    const again = screen.getByRole('textbox', { name: 'Multiplicador de claude-opus-5-5' });
    fireEvent.change(again, { target: { value: 'abc' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    fireEvent.change(again, { target: { value: '' } });
    fireEvent.blur(again);
    await waitFor(() => expect(seen.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ rates: { 'claude-opus-5-5': 1.3 } }, { rates: { 'claude-opus-5-5': null } }]));
  });

  it('por rol o por proyecto', async () => {
    fakeUsageCore();
    render(<SettingsView section="uso" />);
    await screen.findByTestId('total-month');
    expect(screen.getByRole('heading', { name: 'Por rol' })).toBeTruthy();
    expect(screen.getByText('Mente')).toBeTruthy();
    expect(screen.getByText('Revisor')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Agrupar por' })).getByRole('radio', { name: 'Proyecto' }));
    expect(screen.getByRole('heading', { name: 'Por proyecto' })).toBeTruthy();
    expect(screen.getByText('Vetworld')).toBeTruthy();
    expect(screen.getByText('Sin proyecto')).toBeTruthy();
  });

  it('sin la ruta en el núcleo avisa en lugar de romperse', async () => {
    fakeUsageCore({ fail: true });
    render(<SettingsView section="uso" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/El núcleo todavía no tiene esta función/);
  });
});

describe('acceso y formato', () => {
  it('#/perfil y #/ajustes/uso llevan a la sección; la navegación de ajustes la lista', () => {
    expect(parseRoute(PROFILE_HASH)).toEqual({ name: 'settings', section: 'uso' });
    expect(routeHash({ name: 'settings', section: 'uso' })).toBe('#/ajustes/uso');
    expect(parseRoute('#/ajustes/uso')).toEqual({ name: 'settings', section: 'uso' });
    fakeUsageCore();
    render(<SettingsView section="general" />);
    const link = screen.getByRole('link', { name: 'Uso y gasto' });
    expect(link.getAttribute('href')).toBe('#/ajustes/uso');
  });

  it('cifras en español', () => {
    expect(formatUsd(87.980337)).toBe('87,98 USD');
    expect(formatUsd(0.016903)).toBe('0,0169 USD');
    expect(formatUsd(0)).toBe('0,00 USD');
    expect(formatTokens(104116882)).toMatch(/^104,1\sM$/);
    expect(parseMultiplier('1,3')).toBe(1.3);
    expect(parseMultiplier('1.25')).toBe(1.25);
    expect(parseMultiplier('x')).toBeNull();
  });
});
