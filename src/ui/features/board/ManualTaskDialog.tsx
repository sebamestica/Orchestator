import {
  Button,
  ModalBackdrop,
  ModalBody,
  ModalCloseTrigger,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  Switch,
} from '@heroui/react';
import { AlertCircle, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client.ts';
import type { AgentRecord, ProjectRecord } from '../../api/types.ts';
import type { ManualTaskBody } from '../../../shared/index.ts';

interface ManualTaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectRecord[];
  agents: AgentRecord[];
  defaultProjectId?: string;
  onCreated: () => void;
}

export function ManualTaskDialog({
  isOpen,
  onClose,
  projects,
  agents,
  defaultProjectId,
  onCreated,
}: ManualTaskDialogProps) {
  const [projectId, setProjectId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [ownedPathsText, setOwnedPathsText] = useState('');
  const [acceptanceText, setAcceptanceText] = useState('');
  const [agentId, setAgentId] = useState('');
  const [approve, setApprove] = useState(true);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const initialProject = defaultProjectId || (projects.length > 0 ? projects[0]?.id : '') || '';
      setProjectId(initialProject);
      setTitle('');
      setObjective('');
      setOwnedPathsText('');
      setAcceptanceText('');
      setAgentId('');
      setApprove(true);
      setErrorNotice(null);
      setSubmitting(false);
    }
  }, [isOpen, defaultProjectId, projects]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorNotice(null);

    if (!projectId.trim()) {
      setErrorNotice('Debes seleccionar un proyecto.');
      return;
    }
    if (!title.trim()) {
      setErrorNotice('El título es obligatorio.');
      return;
    }
    if (!objective.trim()) {
      setErrorNotice('El objetivo es obligatorio.');
      return;
    }

    const paths = ownedPathsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (paths.length === 0) {
      setErrorNotice('Debes indicar al menos una ruta propia.');
      return;
    }

    const acceptance = acceptanceText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const body: ManualTaskBody = {
      projectId: projectId.trim(),
      title: title.trim(),
      objective: objective.trim(),
      ownedPaths: paths,
      acceptance,
      approve,
      ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
    };

    try {
      setSubmitting(true);
      await api.post('/tasks/manual', body);
      onCreated();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorNotice(`Aviso: Error ${err.status} (${err.code}) al crear la tarea manual: ${err.message}`);
      } else {
        setErrorNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalBackdrop isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalContainer size="lg">
        <ModalDialog className="max-w-2xl bg-[var(--surface)] border border-foreground/[0.08] shadow-2xl backdrop-blur-md">
          <form onSubmit={handleSubmit} noValidate>
            <ModalHeader className="border-b border-foreground/[0.06] pb-3">
              <ModalHeading className="text-base font-semibold text-foreground">
                Nueva tarea a mano
              </ModalHeading>
              <p className="text-xs text-muted mt-0.5">
                Crea un encargo puntual directamente para la flota.
              </p>
            </ModalHeader>

            <ModalBody className="flex flex-col gap-4 py-4 max-h-[65vh] overflow-y-auto">
              {errorNotice && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger"
                >
                  <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="min-w-0 flex-1">{errorNotice}</div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="manual-project-select" className="text-xs font-medium text-foreground">
                    Proyecto *
                  </label>
                  <select
                    id="manual-project-select"
                    aria-label="Proyecto"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="w-full rounded-lg border border-foreground/[0.1] bg-foreground/[0.05] px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-foreground"
                    required
                  >
                    <option value="">Selecciona un proyecto</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="manual-agent-select" className="text-xs font-medium text-foreground">
                    Agente (opcional)
                  </label>
                  <select
                    id="manual-agent-select"
                    aria-label="Agente"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    className="w-full rounded-lg border border-foreground/[0.1] bg-foreground/[0.05] px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-foreground"
                  >
                    <option value="">Automático / Sin asignar</option>
                    {agents.map((a) => (
                      <option key={a.config.id} value={a.config.id}>
                        {a.config.displayName} ({a.config.id})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="manual-task-title" className="text-xs font-medium text-foreground">
                  Título de la tarea *
                </label>
                <input
                  id="manual-task-title"
                  type="text"
                  aria-label="Título"
                  maxLength={120}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ej: Implementar vista de configuración"
                  className="w-full rounded-lg border border-foreground/[0.1] bg-foreground/[0.05] px-3 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-foreground"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="manual-task-objective" className="text-xs font-medium text-foreground">
                  Objetivo *
                </label>
                <textarea
                  id="manual-task-objective"
                  rows={3}
                  aria-label="Objetivo"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="Detalla qué debe hacer la tarea de forma autónoma..."
                  className="w-full rounded-lg border border-foreground/[0.1] bg-foreground/[0.05] px-3 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-foreground resize-y"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="manual-task-paths" className="text-xs font-medium text-foreground">
                  Rutas propias (una por línea) *
                </label>
                <textarea
                  id="manual-task-paths"
                  rows={3}
                  aria-label="Rutas propias"
                  value={ownedPathsText}
                  onChange={(e) => setOwnedPathsText(e.target.value)}
                  placeholder={"src/ui/features/...\ntests/ui/..."}
                  className="w-full rounded-lg border border-foreground/[0.1] bg-foreground/[0.05] px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-foreground resize-y"
                  required
                />
                <span className="text-[11px] text-muted">
                  Archivos o carpetas que solo esta tarea tiene derecho a modificar.
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="manual-task-criteria" className="text-xs font-medium text-foreground">
                  Criterios de aceptación (uno por línea, opcional)
                </label>
                <textarea
                  id="manual-task-criteria"
                  rows={3}
                  aria-label="Criterios de aceptación"
                  value={acceptanceText}
                  onChange={(e) => setAcceptanceText(e.target.value)}
                  placeholder={"Pruebas unitarias pasando\nSin errores de TypeScript"}
                  className="w-full rounded-lg border border-foreground/[0.1] bg-foreground/[0.05] px-3 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-foreground resize-y"
                />
              </div>

              <div className="flex items-center justify-between rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-3">
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-foreground">Aprobar al crear</span>
                  <span className="text-[11px] text-muted">
                    Pasa la tarea directamente a la cola lista para ser asignada.
                  </span>
                </div>
                <Switch
                  aria-label="Aprobar al crear"
                  isSelected={approve}
                  onChange={setApprove}
                />
              </div>
            </ModalBody>

            <ModalFooter className="flex items-center justify-end gap-2 border-t border-foreground/[0.06] pt-3">
              <Button
                variant="ghost"
                size="sm"
                onPress={onClose}
                aria-label="Cancelar creación"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                isDisabled={submitting}
                aria-label="Crear tarea manual"
              >
                <Plus className="size-4 mr-1.5" aria-hidden="true" />
                Crear tarea
              </Button>
            </ModalFooter>
            <ModalCloseTrigger aria-label="Cerrar modal de tarea manual" />
          </form>
        </ModalDialog>
      </ModalContainer>
    </ModalBackdrop>
  );
}
