import { Button, Chip } from '@heroui/react';
import { Bot, Check, ChevronRight, ListChecks, RefreshCw, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { Proposal } from '../../../../shared/api.ts';
import { Panel } from '../../../components/Card.tsx';
import { awaitsDelivery, undeliveredReason, type Decision, type Undelivered } from '../store.ts';
import { Markdown } from './Markdown.tsx';

type ChipState = { label: string; color: 'default' | 'warning' | 'danger' | 'accent' };

/** Una `approved` quieta no llegó a la flota: la entregada pasa enseguida a `delegated`. */
const APPROVAL: Record<Proposal['approval'], ChipState> = {
  proposed: { label: 'Propuesta', color: 'default' },
  approved: { label: 'Aprobada · sin entregar', color: 'warning' },
  rejected: { label: 'Rechazada', color: 'danger' },
  delegated: { label: 'Delegada', color: 'accent' },
};
/** Aprobada con la aprobación (o el reintento) en curso: aún no se sabe si la flota la recibió. */
const DELIVERING: ChipState = { label: 'Entregando…', color: 'default' };

interface ProposalsCardProps {
  proposals: readonly Proposal[];
  /** Propuestas sin decidir o sin entregar en todo el chat (lo que aprueba «Aprobar todo»). */
  pendingInChat: number;
  /** Motivo conocido de cada aprobada que no llegó a la flota. */
  undelivered: Undelivered;
  busy: Record<string, true>;
  agentName: (id: string) => string;
  onDecide: (taskId: string, decision: Decision) => void;
  onApproveAll: () => void;
}

interface ProposalRowProps {
  proposal: Proposal;
  reason: string | null;
  busy: boolean;
  agentName: (id: string) => string;
  onDecide: ProposalsCardProps['onDecide'];
}

function ProposalRow({ proposal, reason, busy, agentName, onDecide }: ProposalRowProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { task, approval } = proposal;
  const undelivered = approval === 'approved' && !busy;
  const state = approval === 'approved' && busy ? DELIVERING : APPROVAL[approval];
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid={`proposal-${task.id}`}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          aria-label={open ? `Ocultar detalle de ${task.id}` : `Ver detalle de ${task.id}`}
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-quick hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <ChevronRight className={`size-3.5 transition-transform duration-quick ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[0.75rem] text-muted">{task.id}</span>
            <span className="selectable min-w-0 text-[0.875rem] font-medium text-foreground">{task.title}</span>
            <Chip size="sm" variant="soft" color={state.color}>
              {state.label}
            </Chip>
          </div>
          <dl className="mt-1.5 flex flex-col gap-1 text-[0.75rem] text-muted">
            {task.suggestedAgent ? (
              <div className="flex items-center gap-1.5">
                <dt className="sr-only">Agente sugerido</dt>
                <Bot className="size-3.5" aria-hidden="true" />
                <dd>{agentName(task.suggestedAgent)}</dd>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              <dt className="mr-0.5">Rutas propias</dt>
              {task.ownedPaths.map((p) => (
                <dd key={p} className="rounded-md bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground">
                  {p}
                </dd>
              ))}
            </div>
            {task.dependsOn.length ? (
              <div className="flex flex-wrap items-center gap-1">
                <dt className="mr-0.5">Depende de</dt>
                {task.dependsOn.map((d) => (
                  <dd key={d} className="font-mono text-[0.6875rem]">
                    {d}
                  </dd>
                ))}
              </div>
            ) : null}
          </dl>
          {undelivered && reason ? <p className="selectable mt-1.5 text-[0.75rem] text-warning">No llegó a la flota: {reason}</p> : null}
        </div>
        {awaitsDelivery(proposal) ? (
          <div className="flex shrink-0 items-center gap-1">
            {approval === 'proposed' ? (
              <Button size="sm" variant="primary" isDisabled={busy} onPress={() => onDecide(task.id, 'approve')} aria-label={`Aprobar ${task.id}`}>
                <Check className="size-3.5" aria-hidden="true" />
                Aprobar
              </Button>
            ) : (
              <Button size="sm" variant="primary" isDisabled={busy} onPress={() => onDecide(task.id, 'approve')} aria-label={`Reintentar entrega de ${task.id}`}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Reintentar entrega
              </Button>
            )}
            <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => onDecide(task.id, 'reject')} aria-label={`Rechazar ${task.id}`}>
              <X className="size-3.5" aria-hidden="true" />
              Rechazar
            </Button>
          </div>
        ) : null}
      </div>
      {open ? (
        <div id={id} className="ml-8 flex flex-col gap-3 rounded-xl bg-foreground/[0.03] p-3">
          <div className="flex flex-col gap-1">
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted">Objetivo</span>
            <Markdown text={task.objective} />
          </div>
          {task.acceptance.length ? (
            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] uppercase tracking-wide text-muted">Criterios de aceptación</span>
              <ul className="selectable flex list-disc flex-col gap-1 pl-5 text-[0.875rem] marker:text-muted">
                {task.acceptance.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Tarjeta de tareas que propone la mente, dentro del hilo: aprobar, rechazar, reintentar la entrega o aprobar todo. */
export function ProposalsCard({ proposals, pendingInChat, undelivered, busy, agentName, onDecide, onApproveAll }: ProposalsCardProps) {
  const pendingHere = proposals.some(awaitsDelivery);
  return (
    <Panel className="overflow-hidden" role="group" aria-label="Tareas propuestas">
      <div className="flex items-center gap-2 border-b border-foreground/[0.06] px-4 py-3">
        <ListChecks className="size-4 text-muted" aria-hidden="true" />
        <span className="flex-1 text-[0.875rem] font-medium text-foreground">
          {proposals.length === 1 ? '1 tarea propuesta' : `${proposals.length} tareas propuestas`}
        </span>
        {pendingHere ? (
          <Button size="sm" variant="secondary" isDisabled={Boolean(busy['*'])} onPress={onApproveAll}>
            <Check className="size-3.5" aria-hidden="true" />
            {pendingInChat > 1 ? `Aprobar todo (${pendingInChat})` : 'Aprobar todo'}
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-foreground/[0.06]">
        {proposals.map((p) => (
          <ProposalRow
            key={p.task.id}
            proposal={p}
            reason={undeliveredReason(undelivered, p.task.id)}
            busy={Boolean(busy[p.task.id] ?? busy['*'])}
            agentName={agentName}
            onDecide={onDecide}
          />
        ))}
      </ul>
    </Panel>
  );
}
