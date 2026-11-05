/**
 * Ajustes › Uso y gasto (issue 5): tokens y gasto de la API por modelo, con el periodo (hoy, 7 días, mes calendario),
 * barras diarias, tablas por modelo y por rol o proyecto, Codex y agy aparte como suscripción y la tarifa propia
 * (multiplicador por modelo). Datos de `GET /usage/summary`; la tarifa se guarda con `PATCH /usage/rates`.
 */
import { Input, Spinner } from '@heroui/react';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  MAX_USAGE_MULTIPLIER,
  usageRatesResponse,
  usageSummaryResponse,
  type UsageBucket,
  type UsageModelRow,
  type UsagePeriod,
  type UsageRole,
  type UsageSplit,
  type UsageSubscriptionRow,
  type UsageSummary,
} from '../../../shared/api.ts';
import { api } from '../../api/client.ts';
import { IconButton } from '../../components/IconButton.tsx';
import { formatDay, formatFull, formatMultiplier, formatPercent, formatTokens, formatUsd, parseMultiplier } from './usage-format.ts';
import { errorText, Notice, Segmented, SettingsCard } from './shared.tsx';

const PERIODS: readonly { value: UsagePeriod; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: '7 días' },
  { value: 'month', label: 'Este mes' },
];

const ROLE_LABEL: Record<UsageRole, string> = {
  mind: 'Mente',
  author: 'Autor',
  reviewer: 'Revisor',
  planner: 'Planificador',
  other: 'Otros (sin tarea)',
};

type Load = { status: 'loading' } | { status: 'ready'; data: UsageSummary } | { status: 'error'; message: string };

export function UsageSection() {
  const [period, setPeriod] = useState<UsagePeriod>('month');
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    api.get<unknown>(`/usage/summary?period=${period}`).then(
      (r) => {
        if (!alive) return;
        const parsed = usageSummaryResponse.safeParse(r);
        setState(parsed.success ? { status: 'ready', data: parsed.data } : { status: 'error', message: 'El núcleo devolvió el resumen de uso con un formato inesperado.' });
      },
      (err: unknown) => {
        if (alive) setState({ status: 'error', message: errorText(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [period, version]);

  const data = state.status === 'ready' ? state.data : null;
  // Mientras llega el periodo nuevo se sigue viendo el anterior (sin parpadeo); el selector ya marca el nuevo.
  const stale = data !== null && data.period !== period;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Periodo" value={period} options={PERIODS} onChange={setPeriod} />
        <span className="flex items-center gap-2 text-[0.75rem] text-muted">
          {stale ? <Spinner size="sm" /> : null}
          {data ? <span>Días en {data.timeZone} · USD</span> : null}
          <IconButton label="Actualizar" size="sm" onClick={reload}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </IconButton>
        </span>
      </div>

      {state.status === 'loading' ? (
        <span className="flex items-center gap-2 text-[0.8125rem] text-muted">
          <Spinner size="sm" /> Cargando…
        </span>
      ) : null}
      {state.status === 'error' ? <Notice>{state.message}</Notice> : null}

      {data ? (
        <>
          <PeriodTiles data={data} selected={period} onSelect={setPeriod} />
          {data.byDay.length > 1 ? <DailyBars data={data} /> : null}
          <ModelsCard rows={data.byModel.filter((m) => m.billing === 'api')} total={data.totals.api} onSaved={reload} />
          <BreakdownCard data={data} />
          <SubscriptionsCard rows={data.subscriptions} total={data.totals.subscription} />
          <UsageNotes data={data} />
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ tarjetas de total

function PeriodTiles({ data, selected, onSelect }: { data: UsageSummary; selected: UsagePeriod; onSelect: (p: UsagePeriod) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {PERIODS.map((p) => {
        const totals = data.periods[p.value];
        const on = p.value === selected;
        return (
          <button
            key={p.value}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(p.value)}
            className={`glass-surface flex h-full flex-col gap-1 rounded-2xl border border-foreground/[0.06] bg-[var(--surface)] px-4 py-3.5 text-left transition-colors duration-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground motion-reduce:transition-none ${on ? 'ring-1 ring-foreground/25' : 'hover:bg-foreground/[0.03]'}`}
          >
              <span className="text-[0.75rem] font-medium uppercase tracking-wide text-muted">{p.label}</span>
              <span className="text-[1.375rem] font-semibold tabular-nums tracking-tight text-foreground" data-testid={`total-${p.value}`}>
                {formatUsd(totals.api.costWithRateUsd)}
              </span>
              <span className="text-[0.75rem] text-muted">con tu tarifa</span>
              <span className="mt-1 text-[0.8125rem] tabular-nums text-foreground">
                {formatUsd(totals.api.costUsd)} <span className="text-muted">estimado (precios públicos)</span>
              </span>
              <span className="text-[0.75rem] tabular-nums text-muted" title={`${formatFull(totals.api.totalTokens)} tokens de la API · ${formatFull(totals.subscription.totalTokens)} de suscripción`}>
                {formatTokens(totals.api.totalTokens)} tokens API · {formatTokens(totals.subscription.totalTokens)} de suscripción
              </span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ barras diarias

/** Barras del gasto diario de la API con tu tarifa (CSS, sin librería): la lectura de arriba sigue al puntero. */
function DailyBars({ data }: { data: UsageSummary }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = data.byDay.map((d) => d.api.costWithRateUsd);
  const max = Math.max(0, ...values);
  const day = hover === null ? undefined : data.byDay[hover];
  const total = data.totals.api;
  const labelIdx = new Set([0, Math.floor((data.byDay.length - 1) / 2), data.byDay.length - 1]);

  return (
    <SettingsCard title="Gasto diario de la API" description="Con tu tarifa, por día del periodo.">
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="min-h-5 text-[0.8125rem] tabular-nums text-muted" aria-live="polite">
          {day ? (
            <>
              <span className="font-medium text-foreground">{formatDay(day.day)}</span> · {formatUsd(day.api.costWithRateUsd)} con tu tarifa · {formatUsd(day.api.costUsd)} estimado · {formatTokens(day.api.totalTokens)} tokens API · {formatTokens(day.subscription.totalTokens)} de suscripción
            </>
          ) : (
            <>
              Total {formatUsd(total.costWithRateUsd)} · máximo diario {formatUsd(max)}
            </>
          )}
        </p>
        {max === 0 ? (
          <Notice tone="info">Sin gasto de la API en el periodo.</Notice>
        ) : (
          <div>
            <div role="list" aria-label="Gasto diario con tu tarifa" className="flex h-36 items-end gap-[2px] border-b border-foreground/[0.12]" onMouseLeave={() => setHover(null)}>
              {data.byDay.map((d, i) => {
                const v = d.api.costWithRateUsd;
                const h = v > 0 ? Math.max(2, (v / max) * 100) : 0;
                return (
                  <div
                    key={d.day}
                    role="listitem"
                    aria-label={`${formatDay(d.day)}: ${formatUsd(v)} con tu tarifa, ${formatUsd(d.api.costUsd)} estimado`}
                    className="flex h-full min-w-0 flex-1 items-end"
                    onMouseEnter={() => setHover(i)}
                  >
                    <div
                      className={`w-full rounded-t-[4px] transition-colors duration-quick ${hover === i ? 'bg-foreground' : 'bg-foreground/55'}`}
                      style={{ height: `${h}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex gap-[2px] text-[0.6875rem] tabular-nums text-muted" aria-hidden="true">
              {data.byDay.map((d, i) => (
                <span key={d.day} className={`min-w-0 flex-1 whitespace-nowrap ${i === data.byDay.length - 1 ? 'text-right' : i === 0 ? 'text-left' : 'text-center'}`}>
                  {labelIdx.has(i) ? formatDay(d.day) : ''}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

// ------------------------------------------------------------------ tablas

const th = 'px-3 py-2 text-right text-[0.75rem] font-normal text-muted first:pl-4 first:text-left last:pr-4';
const td = 'px-3 py-2.5 text-right tabular-nums first:pl-4 first:text-left last:pr-4';

function Tokens({ n }: { n: number }) {
  return <span title={formatFull(n)}>{formatTokens(n)}</span>;
}

function ModelsCard({ rows, total, onSaved }: { rows: UsageModelRow[]; total: UsageBucket; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const save = async (model: string, value: number | null) => {
    setError(null);
    try {
      usageRatesResponse.parse(await api.patch<unknown>('/usage/rates', { rates: { [model]: value } }));
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <SettingsCard title="Por modelo (API)" description="Tokens separados y costo. «Tarifa» multiplica el estimado de ese modelo; vale para todo lo registrado.">
      {error ? (
        <div className="p-3">
          <Notice>{error}</Notice>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="p-4">
          <Notice tone="info">Sin uso de la API en el periodo.</Notice>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-[0.8125rem] text-foreground">
            <thead>
              <tr>
                <th className={th}>Modelo</th>
                <th className={th}>Entrada nueva</th>
                <th className={th}>Caché escrita</th>
                <th className={th}>Caché leída</th>
                <th className={th}>Salida</th>
                <th className={th}>Estimado</th>
                <th className={th}>Tarifa</th>
                <th className={th}>Con tu tarifa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.model ?? '(sin modelo)'} className="border-t border-foreground/[0.06]">
                  <td className={td}>
                    <span className="font-mono text-[0.75rem]">{m.model ?? 'sin modelo'}</span>
                    {m.withoutCost > 0 ? <span className="block text-[0.6875rem] text-muted">{m.withoutCost} sin costo informado</span> : null}
                  </td>
                  <td className={td}>
                    <Tokens n={m.inputTokens} />
                  </td>
                  <td className={td}>
                    <Tokens n={m.cacheWriteTokens} />
                  </td>
                  <td className={td}>
                    <Tokens n={m.cacheReadTokens} />
                  </td>
                  <td className={td}>
                    <Tokens n={m.outputTokens} />
                  </td>
                  <td className={td}>{formatUsd(m.costUsd)}</td>
                  <td className={td}>{m.model ? <RateInput model={m.model} value={m.multiplier} onCommit={save} /> : formatMultiplier(m.multiplier)}</td>
                  <td className={`${td} font-medium`}>{formatUsd(m.costWithRateUsd)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-foreground/[0.12] font-medium">
                <td className={td}>Total</td>
                <td className={td}>
                  <Tokens n={total.inputTokens} />
                </td>
                <td className={td}>
                  <Tokens n={total.cacheWriteTokens} />
                </td>
                <td className={td}>
                  <Tokens n={total.cacheReadTokens} />
                </td>
                <td className={td}>
                  <Tokens n={total.outputTokens} />
                </td>
                <td className={td}>{formatUsd(total.costUsd)}</td>
                <td className={td} />
                <td className={td}>{formatUsd(total.costWithRateUsd)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

/** Multiplicador editable: se guarda al salir del campo o con Enter; vacío vuelve a 1. */
function RateInput({ model, value, onCommit }: { model: string; value: number; onCommit: (model: string, value: number | null) => Promise<void> }) {
  const shown = String(value).replace('.', ',');
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text.trim() === '') {
      if (value !== 1) void onCommit(model, null);
      else setText(shown);
      return;
    }
    const n = parseMultiplier(text);
    if (n === null || n <= 0 || n > MAX_USAGE_MULTIPLIER) {
      setText(shown);
      return;
    }
    if (n !== value) void onCommit(model, n);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        aria-label={`Multiplicador de ${model}`}
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className="h-8 w-16 py-0 text-right"
      />
      <span className="text-muted">×</span>
    </span>
  );
}

function BreakdownCard({ data }: { data: UsageSummary }) {
  const [by, setBy] = useState<'role' | 'project'>('role');
  const rows: { key: string; label: string; split: UsageSplit }[] =
    by === 'role'
      ? data.byRole.map((r) => ({ key: r.role, label: ROLE_LABEL[r.role], split: r }))
      : data.byProject.map((p) => ({ key: p.projectId ?? '(sin proyecto)', label: p.name ?? p.projectId ?? 'Sin proyecto', split: p }));
  return (
    <SettingsCard
      title={by === 'role' ? 'Por rol' : 'Por proyecto'}
      description="Quién gastó: la mente, el autor y el revisor de cada tarea o el planificador."
      actions={
        <Segmented
          label="Agrupar por"
          value={by}
          options={[
            { value: 'role', label: 'Rol' },
            { value: 'project', label: 'Proyecto' },
          ]}
          onChange={setBy}
        />
      }
    >
      {rows.length === 0 ? (
        <div className="p-4">
          <Notice tone="info">Sin uso en el periodo.</Notice>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-[0.8125rem] text-foreground">
            <thead>
              <tr>
                <th className={th}>{by === 'role' ? 'Rol' : 'Proyecto'}</th>
                <th className={th}>Tokens API</th>
                <th className={th}>Estimado</th>
                <th className={th}>Con tu tarifa</th>
                <th className={th}>Tokens de suscripción</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-foreground/[0.06]">
                  <td className={td}>{r.label}</td>
                  <td className={td}>
                    <Tokens n={r.split.api.totalTokens} />
                  </td>
                  <td className={td}>{formatUsd(r.split.api.costUsd)}</td>
                  <td className={`${td} font-medium`}>{formatUsd(r.split.api.costWithRateUsd)}</td>
                  <td className={td}>
                    <Tokens n={r.split.subscription.totalTokens} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

function quotaText(r: UsageSubscriptionRow): string {
  if (r.quotaRemaining === null) return '—';
  return `${formatPercent(r.quotaRemaining)}${r.quotaStale ? ' (lectura antigua)' : ''}`;
}

function SubscriptionsCard({ rows, total }: { rows: UsageSubscriptionRow[]; total: UsageBucket }) {
  return (
    <SettingsCard title="Suscripción (Codex y agy)" description="Van por cupo de la suscripción: tokens sin costo de la API.">
      {rows.length === 0 ? (
        <div className="p-4">
          <Notice tone="info">No hay agentes de suscripción registrados.</Notice>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-[0.8125rem] text-foreground">
            <thead>
              <tr>
                <th className={th}>Agente</th>
                <th className={th}>Entrada nueva</th>
                <th className={th}>Caché leída</th>
                <th className={th}>Salida</th>
                <th className={th}>Total</th>
                <th className={th}>Cupo restante</th>
                <th className={th}>Costo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agentId} className="border-t border-foreground/[0.06]">
                  <td className={td}>
                    {r.displayName}
                    <span className="block font-mono text-[0.6875rem] text-muted">{r.models.length ? r.models.join(', ') : 'modelo no informado'}</span>
                  </td>
                  <td className={td}>
                    <Tokens n={r.inputTokens} />
                  </td>
                  <td className={td}>
                    <Tokens n={r.cacheReadTokens} />
                  </td>
                  <td className={td}>
                    <Tokens n={r.outputTokens} />
                  </td>
                  <td className={`${td} font-medium`}>
                    <Tokens n={r.totalTokens} />
                  </td>
                  <td className={td}>{quotaText(r)}</td>
                  <td className={`${td} text-muted`}>suscripción</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-foreground/[0.12] font-medium">
                <td className={td}>Total</td>
                <td className={td}>
                  <Tokens n={total.inputTokens} />
                </td>
                <td className={td}>
                  <Tokens n={total.cacheReadTokens} />
                </td>
                <td className={td}>
                  <Tokens n={total.outputTokens} />
                </td>
                <td className={td}>
                  <Tokens n={total.totalTokens} />
                </td>
                <td className={td} />
                <td className={td} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

function UsageNotes({ data }: { data: UsageSummary }) {
  const c = data.coverage;
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="info">
        El costo es una estimación local con precios públicos: lo informa el SDK de Claude al terminar cada sesión. «Con tu tarifa» lo multiplica por el factor de cada
        modelo (por defecto 1,0). Según docs/DECISIONES.md, tu servidor cobra Opus 5.5 a 5,2 / 26 USD por millón de tokens de entrada / salida, unas 1,3× los precios
        públicos (4 / 20).
      </Notice>
      {c.withoutCacheWrite > 0 ? (
        <Notice tone="info">
          {c.withoutCacheWrite} {c.withoutCacheWrite === 1 ? 'registro' : 'registros'} de la API {c.withoutCacheWrite === 1 ? 'es anterior' : 'son anteriores'} a separar la caché escrita: en ellos va dentro de la entrada nueva.
        </Notice>
      ) : null}
      {c.withoutCost > 0 ? (
        <Notice tone="info">
          {c.withoutCost} {c.withoutCost === 1 ? 'registro' : 'registros'} de la API sin costo informado: suman 0.
        </Notice>
      ) : null}
      {c.unlinked > 0 ? (
        <Notice tone="info">
          {c.unlinked} {c.unlinked === 1 ? 'registro no está enlazado' : 'registros no están enlazados'} a una tarea ni a un chat (sesiones sueltas o anteriores al enlace): van en «Otros».
        </Notice>
      ) : null}
    </div>
  );
}
