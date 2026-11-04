import { memo, useEffect, useState } from 'react';
import { Chip } from '@heroui/react';
import { ChevronDown, ChevronRight, Terminal, Check, AlertCircle } from 'lucide-react';
import { api, ApiError } from '../../api/client.ts';
import { getLive } from '../../api/live.ts';
import type { AgentEvent, QuotaRecord } from '../../api/types.ts';
import { useApp } from '../../store/app.ts';
import { applyEvents, dailyUsageSchema, initialView, isActive, sessionsSchema, type SessionView } from './model.ts';

const money = (value: number) => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
const number = (value: number) => value.toLocaleString('es-CL');
const labels = { starting: 'Iniciando', running: 'En curso', waiting: 'En espera', done: 'Terminada', failed: 'Fallida', cancelled: 'Cancelada' };
const colors = { starting: 'bg-amber-400', running: 'bg-emerald-400', waiting: 'bg-amber-400', done: 'bg-foreground/40', failed: 'bg-red-400', cancelled: 'bg-foreground/40' };

function EventRow({ event, expanded }: { event: AgentEvent; expanded: boolean }) {
  const compact = expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2 break-words';
  switch (event.type) {
    case 'text': return <p className={compact}>{event.payload.text}</p>;
    case 'raw': return <p className={compact}>{event.payload.line}</p>;
    case 'tool_call': return <div className="flex gap-2"><Terminal size={14} className="shrink-0" aria-hidden="true" /><p className={compact}>{event.payload.name} · {event.payload.inputSummary}</p></div>;
    case 'tool_result': return <div className="flex gap-2">{event.payload.ok ? <Check size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}<p className={compact}>{event.payload.summary}</p></div>;
    case 'file_change': return <Chip size="sm" className="max-w-full"><span className="break-all">{event.payload.change === 'add' ? '+' : event.payload.change === 'delete' ? '−' : '~'} {event.payload.path}</span></Chip>;
    case 'error': return <p className={`text-red-400 ${compact}`}>{event.payload.message}</p>;
    case 'status': return <p>{labels[event.payload.state]}{event.payload.detail ? ` · ${event.payload.detail}` : ''}</p>;
    case 'done': return <p className={compact}>{event.payload.summary ?? (event.payload.ok ? 'Sesión terminada' : 'La sesión falló')}</p>;
    case 'usage': return null;
  }
}

function Quota({ quota }: { quota: QuotaRecord | undefined }) {
  const bucket = quota?.snapshot.buckets.filter((b) => b.remainingFraction !== null).sort((a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1))[0];
  if (!bucket || bucket.remainingFraction === null) return <p className="text-muted">Cupo no disponible</p>;
  const percent = Math.round(bucket.remainingFraction * 100);
  return <div className="space-y-1.5">
    <div className="flex justify-between gap-2 text-muted"><span>{bucket.groupName} · {percent}% restante</span><span>{quota?.snapshot.stale ? 'Lectura antigua' : bucket.window}</span></div>
    <div role="progressbar" aria-label="Cupo restante" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="h-1 overflow-hidden rounded-full bg-foreground/[0.08]"><div className={`h-full ${percent <= 10 ? 'bg-red-400' : 'bg-foreground/60'}`} style={{ width: `${percent}%` }} /></div>
    {bucket.resetAt && <p className="text-muted">Reinicia {new Date(bucket.resetAt).toLocaleString('es-CL')}</p>}
    {quota?.snapshot.error && <p className="text-amber-400">{quota.snapshot.error}</p>}
  </div>;
}

const SessionCard = memo(function SessionCard({ view }: { view: SessionView }) {
  const agent = useApp((s) => s.agents.find((a) => a.config.id === view.session.agentId));
  const quota = useApp((s) => s.quotas[view.session.agentId]);
  const [expanded, setExpanded] = useState(false);
  const name = agent?.config.displayName ?? view.session.agentId;
  function toggle() {
    if (!expanded) getLive()?.replay(view.session.id, view.cursor);
    setExpanded(!expanded);
  }
  return <article aria-label={`Sesión ${view.session.id}`} className="min-w-0 rounded-xl border border-foreground/[0.06] bg-foreground/[0.045] p-3 text-xs">
    <button type="button" onClick={toggle} aria-expanded={expanded} aria-label={`${expanded ? 'Contraer' : 'Expandir'} sesión ${view.session.id}`} className="flex w-full items-start gap-2 rounded-lg text-left hover:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:outline-foreground">
      <span className={`mt-1 size-2 shrink-0 rounded-full ${colors[view.session.state]}`} aria-hidden="true" />
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{name}</span><span className="block truncate text-muted">{view.model ?? agent?.config.model ?? 'Modelo no informado'}</span><span className="block break-all text-muted">{view.session.taskId ? `Tarea ${view.session.taskId}` : 'Sin tarea asociada'}</span></span>
      <span className="text-muted">{labels[view.session.state]}</span>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
    </button>
    <div aria-label={`Transmisión ${view.session.id}`} className={`my-3 space-y-2 text-muted ${expanded ? 'max-h-96 overflow-y-auto' : ''}`}>
      {(expanded ? view.events : view.events.filter((e) => e.type !== 'usage').slice(-3)).map((event) => <EventRow key={event.seq} event={event} expanded={expanded} />)}
      {view.events.length === 0 && <p>Esperando eventos…</p>}
    </div>
    <div className="mb-3 flex flex-wrap justify-between gap-2 tabular-nums"><span>Entrada {number(view.input)} · Salida {number(view.output)}</span><span>{money(view.cost)}</span></div>
    <Quota quota={quota} />
  </article>;
});

function SessionTree({ id, views, ancestors = [] }: { id: string; views: Record<string, SessionView>; ancestors?: string[] }) {
  const view = views[id];
  if (!view || ancestors.includes(id)) return null;
  const children = Object.values(views).filter((child) => child.session.parentSessionId === id && !ancestors.includes(child.session.id));
  return <div className="space-y-2"><SessionCard view={view} />{children.length > 0 && <details open className="ml-3 border-l border-foreground/[0.06] pl-3"><summary className="cursor-pointer py-2 text-xs text-muted">Subagentes ({children.length})</summary><div className="space-y-2">{children.map((child) => <SessionTree key={child.session.id} id={child.session.id} views={views} ancestors={[...ancestors, id]} />)}</div></details>}</div>;
}

export function AgentsPanel() {
  const core = useApp((s) => s.core);
  const liveStatus = useApp((s) => s.live);
  const [views, setViews] = useState<Record<string, SessionView>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [daily, setDaily] = useState<number | null>(null);
  useEffect(() => {
    let stopped = false;
    let frame: number | null = null;
    let pending: unknown[] = [];
    let usageTimer: ReturnType<typeof setTimeout> | null = null;
    const loadDaily = () => {
      void api.get<unknown>('/usage?groupBy=agent,day').then((data) => {
        const { rows } = dailyUsageSchema.parse(data);
        // El servidor agrupa los días en UTC.
        const today = new Date().toISOString().slice(0, 10);
        if (!stopped) setDaily(rows.filter((row) => row.day === today).reduce((sum, row) => sum + row.costUsd, 0));
      }).catch(() => { if (!stopped) setDaily(null); });
    };
    const live = getLive();
    const unsubscribe = live?.subscribe((message) => {
      if (message.type === 'event') {
        pending.push(message.event);
        if (message.event.type === 'usage' && usageTimer === null) {
          usageTimer = setTimeout(() => { usageTimer = null; loadDaily(); }, 1000);
        }
      }
      else if (message.type === 'replay') {
        pending.push(...message.events);
        if (message.hasMore && message.events.length > 0) live.replay(message.sessionId, message.lastSeq);
      } else return;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        const batch = pending;
        pending = [];
        frame = null;
        if (!stopped) setViews((current) => applyEvents(current, batch));
      });
    });
    void api.get<unknown>('/sessions?limit=50').then((data) => {
      const { sessions } = sessionsSchema.parse(data);
      if (stopped) return;
      setNotice(null);
      setViews((current) => {
        const next = { ...current };
        for (const session of sessions) {
          const previous = next[session.id];
          next[session.id] = previous ? { ...previous, session: {
            ...session,
            ...(previous.cursor > session.lastSeq ? { state: previous.session.state, lastSeq: previous.cursor, updatedAt: previous.session.updatedAt } : {}),
          } } : initialView(session);
        }
        return next;
      });
      for (const session of sessions) live?.replay(session.id, -1);
    }).catch((error: unknown) => {
      if (!stopped) setNotice(error instanceof ApiError && [404, 501].includes(error.status) ? 'Las sesiones todavía no están disponibles en este servidor.' : 'No se pudieron cargar las sesiones.');
    });
    loadDaily();
    return () => {
      stopped = true;
      unsubscribe?.();
      if (frame !== null) cancelAnimationFrame(frame);
      if (usageTimer !== null) clearTimeout(usageTimer);
    };
  }, [core, liveStatus]);
  const all = Object.values(views);
  const roots = all.filter((view) => !view.session.parentSessionId || !views[view.session.parentSessionId]);
  function activeBranch(id: string, visited = new Set<string>()): boolean {
    if (visited.has(id)) return false;
    visited.add(id);
    const view = views[id];
    return !!view && (isActive(view) || all.some((child) => child.session.parentSessionId === id && activeBranch(child.session.id, visited)));
  }
  const active = roots.filter((view) => activeBranch(view.session.id));
  const recent = roots.filter((view) => !activeBranch(view.session.id)).slice(0, 50);
  return <aside aria-label="Agentes en vivo" className="chrome-surface hidden w-[var(--panel-width)] shrink-0 flex-col overflow-hidden lg:flex">
    <header className="border-b border-foreground/[0.06] p-4"><h2 className="text-sm font-medium">Agentes en vivo</h2><div className="mt-2 flex justify-between text-xs text-muted"><span>{all.filter(isActive).length} activos</span><span>Hoy · {daily === null ? 'Gasto no disponible' : money(daily)}</span></div></header>
    <div className="flex-1 space-y-3 overflow-y-auto p-3">{notice && <p role="status" className="text-xs text-amber-400">{notice}</p>}{active.map((view) => <SessionTree key={view.session.id} id={view.session.id} views={views} />)}
      {active.length === 0 && <p className="p-2 text-xs text-muted">No hay agentes activos.</p>}
      {recent.length > 0 && <details><summary className="cursor-pointer py-2 text-xs text-muted">Recientes ({recent.length})</summary><div className="space-y-3">{recent.map((view) => <SessionTree key={view.session.id} id={view.session.id} views={views} />)}</div></details>}
    </div>
  </aside>;
}
