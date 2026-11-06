import { useState } from 'react';
import { api } from '../../api/client.ts';
import type { ProjectRecord } from '../../api/types.ts';
import { useApp } from '../../store/app.ts';
import { ConfirmDialog } from '../settings/ConfirmDialog.tsx';
import { errorText } from '../settings/shared.tsx';

/**
 * Confirmar y quitar un proyecto (`DELETE /projects/:id`); lo usan Ajustes › Proyectos y el menú de la barra lateral.
 * `onRemoved` corre tras quitarlo (p. ej. salir de su ruta si era la abierta).
 */
export function RemoveProjectDialog({ project, onClose, onRemoved }: { project: ProjectRecord | null; onClose: () => void; onRemoved?: (project: ProjectRecord) => void }) {
  const refreshProjects = useApp((s) => s.refreshProjects);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setError(null);
    onClose();
  };
  const confirm = async () => {
    if (!project) return;
    setPending(true);
    setError(null);
    try {
      await api.del(`/projects/${encodeURIComponent(project.id)}`);
      onClose();
      onRemoved?.(project);
      await refreshProjects().catch(() => undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <ConfirmDialog
      isOpen={project !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`¿Quitar ${project?.name ?? 'el proyecto'}?`}
      description="Berland lo olvida, pero no toca la carpeta ni el repositorio. Si tiene tareas en curso, cancélalas antes."
      confirmLabel="Quitar"
      isPending={pending}
      error={error}
      onConfirm={() => void confirm()}
    />
  );
}
