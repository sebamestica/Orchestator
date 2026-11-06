import {
  Button,
  Chip,
  ModalBackdrop,
  ModalBody,
  ModalCloseTrigger,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
} from '@heroui/react';
import { AlertCircle, CheckCircle, RefreshCw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../../api/client.ts';
import { retryTask, taskActionError } from '../../api/tasks.ts';
import type { AgentRecord, TaskRecord } from '../../api/types.ts';
import { difficultyLabel, formatRelativeTime } from './types.ts';

interface TaskDetailModalProps {
  task: TaskRecord | null;
  isOpen: boolean;
  onClose: () => void;
  agents: AgentRecord[];
  onTaskUpdated: () => void;
}

const CANCELLABLE_STATES = ['pending', 'ready', 'running', 'review'] as const;

export function TaskDetailModal({ task, isOpen, onClose, agents, onTaskUpdated }: TaskDetailModalProps) {
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!task || !isOpen) return null;

  const brief = task.task;
  const isPending = task.state === 'pending';
  const isFailed = task.state === 'failed';
  const isCancellable = CANCELLABLE_STATES.includes(task.state as (typeof CANCELLABLE_STATES)[number]);
  const currentAgent = agents.find((a) => a.config.id === (task.agentId || brief.suggestedAgent));
  const agentDisplayName = currentAgent?.config.displayName || task.agentId || brief.suggestedAgent || 'Sin asignar';

  const handleApprove = async () => {
    try {
      setSubmitting(true);
      setErrorNotice(null);
      const body = selectedAgent.trim() ? { agentId: selectedAgent.trim() } : {};
      await api.post(`/tasks/${encodeURIComponent(brief.id)}/approve`, body);
      onTaskUpdated();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorNotice(`Aviso: Error ${err.status} (${err.code}) al aprobar la tarea: ${err.message}`);
      } else {
        setErrorNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    try {
      setSubmitting(true);
      setErrorNotice(null);
      await api.post(`/tasks/${encodeURIComponent(brief.id)}/cancel`, {});
      onTaskUpdated();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorNotice(`Aviso: Error ${err.status} (${err.code}) al cancelar la tarea: ${err.message}`);
      } else {
        setErrorNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = async () => {
    try {
      setSubmitting(true);
      setErrorNotice(null);
      await retryTask(brief.id);
      onTaskUpdated();
      onClose();
    } catch (err) {
      setErrorNotice(taskActionError('al reintentar la tarea', err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalBackdrop isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalContainer size="lg">
        <ModalDialog className="max-w-2xl bg-[var(--surface)] border border-foreground/[0.08] shadow-2xl backdrop-blur-md">
          <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] pb-3">
            <div className="flex items-center justify-between gap-3 pr-6">
              <span className="font-mono text-xs text-muted">{brief.id}</span>
              <div className="flex items-center gap-2">
                <Chip size="sm" variant="soft">
                  {task.state}
                </Chip>
                <Chip size="sm" variant="soft">
                  {difficultyLabel(brief.difficulty)}
                </Chip>
              </div>
            </div>
            <ModalHeading className="text-base font-semibold text-foreground break-words">
              {brief.title}
            </ModalHeading>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>Proyecto: <strong className="text-foreground">{brief.projectId}</strong></span>
              <span>Actualizada: {formatRelativeTime(task.updatedAt || task.createdAt)}</span>
              {task.lastEventAt && (
                <span title={new Date(task.lastEventAt).toLocaleString()}>Último evento: {formatRelativeTime(task.lastEventAt)}</span>
              )}
              {task.attempts > 0 && <span>Intentos: {task.attempts}</span>}
            </div>
          </ModalHeader>

          <ModalBody className="flex flex-col gap-4 py-4 max-h-[60vh] overflow-y-auto">
            {isFailed && (
              <section
                aria-label="Motivo del fallo"
                className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger"
              >
                <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">Por qué se detuvo</p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{task.detail || 'Falló sin motivo guardado.'}</p>
                  <p className="mt-1.5 text-danger/80">
                    Al reintentar, el agente sigue en el mismo worktree (o carpeta) con este motivo y el plan de la tarea.
                  </p>
                </div>
              </section>
            )}

            {task.state === 'ready' && task.detail && (
              <p
                aria-label="Motivo del estado"
                className="rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3 text-xs text-muted whitespace-pre-wrap break-words"
              >
                {task.detail}
              </p>
            )}

            {errorNotice && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger"
              >
                <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">{errorNotice}</div>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Objetivo</h4>
              <p className="mt-1.5 whitespace-pre-wrap rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3 text-sm text-foreground">
                {brief.objective}
              </p>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Criterios de aceptación</h4>
              {brief.acceptance && brief.acceptance.length > 0 ? (
                <ul className="mt-1.5 space-y-1 rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3">
                  {brief.acceptance.map((crit, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-xs text-foreground">
                      <span className="text-muted">•</span>
                      <span>{crit}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-xs text-muted italic">Sin criterios especificados.</p>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Rutas propias</h4>
              <div className="mt-1.5 flex flex-wrap gap-1.5 rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3">
                {brief.ownedPaths && brief.ownedPaths.length > 0 ? (
                  brief.ownedPaths.map((p) => (
                    <code
                      key={p}
                      className="rounded bg-foreground/[0.06] px-2 py-0.5 font-mono text-[11px] text-foreground"
                    >
                      {p}
                    </code>
                  ))
                ) : (
                  <span className="text-xs text-muted italic">Sin rutas especificadas.</span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3">
                <span className="font-semibold text-muted">Plan asociado:</span>
                <p className="mt-1 font-mono text-foreground truncate">
                  {task.planId || 'Sin plan'}
                </p>
              </div>

              <div className="rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3">
                <span className="font-semibold text-muted">Agente:</span>
                <p className="mt-1 text-foreground truncate">
                  {agentDisplayName}
                </p>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Dependencias</h4>
              <div className="mt-1.5 flex flex-wrap gap-1.5 rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3">
                {brief.dependsOn && brief.dependsOn.length > 0 ? (
                  brief.dependsOn.map((dep) => (
                    <code
                      key={dep}
                      className="rounded bg-foreground/[0.06] px-2 py-0.5 font-mono text-[11px] text-foreground"
                    >
                      {dep}
                    </code>
                  ))
                ) : (
                  <span className="text-xs text-muted italic">Ninguna dependencia.</span>
                )}
              </div>
            </div>

            {isPending && (
              <div className="rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3 flex flex-col gap-2">
                <label htmlFor="assign-agent-select" className="text-xs font-medium text-foreground">
                  Asignar a un agente al aprobar (opcional):
                </label>
                <select
                  id="assign-agent-select"
                  aria-label="Asignar agente"
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="w-full rounded-lg border border-foreground/[0.1] bg-foreground/[0.05] px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-foreground"
                >
                  <option value="">Predeterminado / Sugerido ({brief.suggestedAgent || 'Automático'})</option>
                  {agents.map((a) => (
                    <option key={a.config.id} value={a.config.id}>
                      {a.config.displayName} ({a.config.id})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </ModalBody>

          <ModalFooter className="flex items-center justify-between border-t border-foreground/[0.06] pt-3">
            <div>
              {isCancellable && (
                <Button
                  variant="danger-soft"
                  size="sm"
                  isDisabled={submitting}
                  onPress={handleCancel}
                  aria-label="Cancelar tarea"
                >
                  <XCircle className="size-4 mr-1.5" aria-hidden="true" />
                  Cancelar tarea
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onPress={onClose}
                aria-label="Cerrar detalle"
              >
                Cerrar
              </Button>
              {isFailed && (
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={submitting}
                  onPress={handleRetry}
                  aria-label="Reintentar tarea"
                >
                  <RefreshCw className="size-4 mr-1.5" aria-hidden="true" />
                  Reintentar
                </Button>
              )}
              {isPending && (
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={submitting}
                  onPress={handleApprove}
                  aria-label="Aprobar tarea"
                >
                  <CheckCircle className="size-4 mr-1.5" aria-hidden="true" />
                  Aprobar
                </Button>
              )}
            </div>
          </ModalFooter>
          <ModalCloseTrigger aria-label="Cerrar modal" />
        </ModalDialog>
      </ModalContainer>
    </ModalBackdrop>
  );
}
