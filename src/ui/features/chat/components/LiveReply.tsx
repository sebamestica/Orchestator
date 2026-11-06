import { Spinner } from '@heroui/react';
import {
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  FileMinus,
  FilePen,
  FilePlus,
  FileText,
  FoldVertical,
  Globe,
  ListChecks,
  ListTree,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { agentEventSchema } from '../../../../shared/events.ts';
import { api, ApiError } from '../../../api/client.ts';
import { formatCost, formatTokens } from '../format.ts';
import { activityOf, buildReply, type LiveItem, type ReplyDraft, type StepItem, type UsageTotals } from '../timeline.ts';
import { Markdown } from './Markdown.tsx';

/** `mcp__orquestador__crear_tareas` → `crear_tareas`. */
export function toolLabel(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  return name.split('__').slice(2).join('__') || name;
}

const isSubagent = (name: string) => name === 'Agent' || name === 'Task';

function toolIcon(name: string): LucideIcon {
  const n = toolLabel(name).toLowerCase();
  if (n === 'read' || n.includes('leer')) return FileText;
  if (n === 'grep' || n === 'glob' || n.includes('buscar') || n.includes('search')) return Search;
  if (n === 'agent' || n === 'task') return Bot;
  if (n.startsWith('web')) return Globe;
  if (n.includes('tarea') || n.includes('plan')) return ListChecks;
  if (n === 'bash' || n === 'powershell') return SquareTerminal;
  return Wrench;
}

const FILE_ICON = { add: FilePlus, modify: FilePen, delete: FileMinus } as const;
const FILE_VERB = { add: 'Creó', modify: 'Editó', delete: 'Borró' } as const;

/** Fila plegable de un paso (icono, nombre y resumen de una línea; al desplegar, el detalle). */
function StepRow({ icon: Icon, title, summary, status, children }: { icon: LucideIcon; title: string; summary: string; status?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const expandable = children !== undefined;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="group flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[0.8125rem] transition-colors duration-quick hover:bg-foreground/[0.045] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:hover:bg-transparent"
      >
        <Icon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">{title}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{summary}</span>
        {status}
        {expandable ? (
          <ChevronRight className={`size-3.5 shrink-0 text-muted transition-transform duration-quick ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        ) : null}
      </button>
      {expandable && open ? (
        <div id={id} className="selectable ml-7 mt-1 mb-2 flex flex-col gap-2">
          {children}
        </div>
      ) : null}
    </li>
  );
}

function Detail({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6875rem] uppercase tracking-wide text-muted">{label}</span>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-foreground/[0.04] p-3 font-mono text-[0.75rem] leading-relaxed text-foreground">{text}</pre>
    </div>
  );
}

const sessionEventsSchema = z.object({ events: z.array(agentEventSchema) });

/** Pasos de un subagente: su sesión hija (id = el de la llamada `Agent`/`Task`), pedida al desplegar su fila. */
function SubagentSteps({ callId }: { callId: string }) {
  const [steps, setSteps] = useState<StepItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .get<unknown>(`/sessions/${encodeURIComponent(callId)}/events?since=-1&limit=500`)
      .then((data) => alive && setSteps(activityOf(buildReply(sessionEventsSchema.parse(data).events))))
      // Sin sesión todavía: el subagente aún no hizo nada.
      .catch((err: unknown) => alive && (err instanceof ApiError && err.status === 404 ? setSteps([]) : setFailed(true)));
    return () => {
      alive = false;
    };
  }, [callId]);
  let body: ReactNode;
  if (failed) body = <span className="text-[0.75rem] text-muted">No se pudieron leer sus pasos.</span>;
  else if (steps === null) body = <span className="text-[0.75rem] text-muted">Cargando sus pasos…</span>;
  else if (steps.length === 0) body = <span className="text-[0.75rem] text-muted">Sin pasos guardados.</span>;
  else
    body = (
      <ul className="flex flex-col border-l border-foreground/[0.08] pl-1">
        {steps.map((step) => (
          <ItemRow key={step.key} item={step} running={false} announce={false} />
        ))}
      </ul>
    );
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6875rem] uppercase tracking-wide text-muted">Pasos del subagente</span>
      {body}
    </div>
  );
}

/**
 * Un paso de trabajo de la mente (herramienta, archivo, error o pensamiento). `announce: false` (historial)
 * pinta el error sin `role="alert"`, para que un lector de pantalla no repita errores viejos en cada carga.
 */
export function ItemRow({ item, running, announce = true }: { item: StepItem; running: boolean; announce?: boolean }) {
  switch (item.kind) {
    case 'tool': {
      const status =
        item.result === null ? (
          running ? (
            <Spinner size="sm" color="current" role="img" className="size-3.5 text-muted" aria-label="En curso" />
          ) : null
        ) : item.result.ok ? (
          <CircleCheck className="size-3.5 shrink-0 text-success" aria-label="Terminó bien" />
        ) : (
          <CircleX className="size-3.5 shrink-0 text-danger" aria-label="Falló" />
        );
      return (
        <StepRow icon={toolIcon(item.name)} title={toolLabel(item.name)} summary={item.input || item.result?.summary || ''} status={status}>
          <>
            <Detail label="Entrada" text={item.input} />
            {isSubagent(item.name) ? <SubagentSteps callId={item.callId} /> : null}
            <Detail label={item.result?.ok === false ? 'Error' : 'Resultado'} text={item.result?.summary ?? ''} />
            {item.result === null ? <span className="text-[0.75rem] text-muted">Sin resultado todavía.</span> : null}
          </>
        </StepRow>
      );
    }
    case 'file':
      return <StepRow icon={FILE_ICON[item.change]} title={FILE_VERB[item.change]} summary={item.path} />;
    case 'error':
      return (
        <li className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[0.8125rem] text-danger" role={announce ? 'alert' : undefined}>
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="selectable min-w-0 break-words">{item.message}</span>
        </li>
      );
    case 'compact':
      return (
        <li className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[0.8125rem] text-muted">
          <FoldVertical className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>La mente resumió la conversación para seguir. Si algo del principio es importante, recuérdaselo.</span>
        </li>
      );
    case 'thinking':
      return (
        <StepRow icon={Brain} title="Pensamiento" summary={item.text.replace(/\s+/g, ' ').trim()}>
          <Markdown text={item.text} muted />
        </StepRow>
      );
  }
}

export function UsageLine({ usage }: { usage: UsageTotals }) {
  return (
    <p className="text-[0.75rem] text-muted" aria-label="Uso de tokens">
      {formatTokens(usage.inputTokens)} de entrada · {formatTokens(usage.outputTokens)} de salida
      {usage.costUsd !== null ? ` · ${formatCost(usage.costUsd)}` : ''}
      {usage.models.length ? ` · ${usage.models.join(', ')}` : ''}
    </p>
  );
}

export function Thinking() {
  return (
    <div role="status" className="flex h-8 items-center gap-2 px-2 text-[0.8125rem] text-muted">
      <Spinner size="sm" color="current" className="size-3.5" aria-hidden="true" />
      <span className="animate-pulse">Pensando…</span>
    </div>
  );
}

/** Respuesta en curso de la mente: texto que llega por partes y pasos plegables, en su orden. */
export function LiveReply({ draft, running }: { draft: ReplyDraft; running: boolean }) {
  return (
    <div className="flex flex-col gap-3" aria-live="polite" aria-busy={running} data-testid="live-reply">
      {groupItems(draft.items).map((group) =>
        group.kind === 'text' ? (
          <Markdown key={group.key} text={group.text} />
        ) : (
          <ul key={group.key} className="flex flex-col">
            {group.items.map((item) => (
              <ItemRow key={item.key} item={item} running={running} />
            ))}
          </ul>
        ),
      )}
      {running ? <Thinking /> : null}
      {draft.usage ? <UsageLine usage={draft.usage} /> : null}
    </div>
  );
}

type Group = { kind: 'text'; key: string; text: string } | { kind: 'steps'; key: string; items: StepItem[] };

function groupItems(items: readonly LiveItem[]): Group[] {
  const out: Group[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      out.push({ kind: 'text', key: item.key, text: item.text });
      continue;
    }
    const tail = out.at(-1);
    if (tail?.kind === 'steps') tail.items.push(item);
    else out.push({ kind: 'steps', key: `steps-${item.key}`, items: [item] });
  }
  return out;
}

/** Pasos de un turno ya respondido, plegados bajo una sola fila. */
export function ActivitySummary({ items }: { items: readonly StepItem[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (items.length === 0) return null;
  const failed = items.filter((i) => (i.kind === 'tool' && i.result?.ok === false) || i.kind === 'error').length;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-fit items-center gap-2 rounded-lg px-2 text-[0.8125rem] text-muted transition-colors duration-quick hover:bg-foreground/[0.045] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      >
        <ListTree className="size-3.5" aria-hidden="true" />
        {items.length === 1 ? '1 paso' : `${items.length} pasos`}
        {failed ? <span className="text-danger">· {failed} con error</span> : null}
        <ChevronRight className={`size-3.5 transition-transform duration-quick ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={id} className="flex flex-col">
          {items.map((item) => (
            <ItemRow key={item.key} item={item} running={false} announce={false} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
