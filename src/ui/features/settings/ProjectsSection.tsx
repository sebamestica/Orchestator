import { Button } from '@heroui/react';
import { FolderX } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client.ts';
import type { ProjectRecord } from '../../api/types.ts';
import { useApp } from '../../store/app.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { errorText, Notice, SettingsCard } from './shared.tsx';

function gateText(project: ProjectRecord): string {
  const gate = project.workspace?.gate;
  if (!gate || gate.length === 0) return 'Sin gate: la flota no ejecuta sus tareas';
  return gate.map((g) => [g.command, ...g.args].join(' ')).join(' && ');
}

export function ProjectsSection() {
  const projects = useApp((s) => s.projects);
  const refreshProjects = useApp((s) => s.refreshProjects);
  const [removing, setRemoving] = useState<ProjectRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!removing) return;
    setPending(true);
    setError(null);
    try {
      await api.del(`/projects/${encodeURIComponent(removing.id)}`);
      setRemoving(null);
      await refreshProjects().catch(() => undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard title="Proyectos" description="Carpetas que conoce Berland. Agrégalas con «+» en la barra lateral.">
        {projects.length === 0 ? (
          <div className="p-4">
            <Notice tone="info">No hay proyectos todavía.</Notice>
          </div>
        ) : (
          projects.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.875rem] font-medium text-foreground">{p.name}</div>
                <div className="truncate font-mono text-[0.75rem] text-muted" title={p.repoPath}>
                  {p.repoPath}
                </div>
                <div className="truncate font-mono text-[0.75rem] text-muted" title={gateText(p)}>
                  Gate: {gateText(p)}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  setError(null);
                  setRemoving(p);
                }}
              >
                <FolderX className="size-4" aria-hidden="true" />
                Quitar
              </Button>
            </div>
          ))
        )}
      </SettingsCard>
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`¿Quitar ${removing?.name ?? 'el proyecto'}?`}
        description="Berland lo olvida, pero no toca la carpeta ni el repositorio. Si tiene tareas en curso, cancélalas antes."
        confirmLabel="Quitar"
        isPending={pending}
        error={error}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}
