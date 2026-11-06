import { Button } from '@heroui/react';
import { FolderX } from 'lucide-react';
import { useState } from 'react';
import type { ProjectRecord } from '../../api/types.ts';
import { useApp } from '../../store/app.ts';
import { RemoveProjectDialog } from '../projects/RemoveProjectDialog.tsx';
import { Notice, SettingsCard } from './shared.tsx';

function gateText(project: ProjectRecord): string {
  const gate = project.workspace?.gate;
  if (!project.workspace) return 'Modo local: se trabaja directo en la carpeta, sin worktrees ni commits';
  if (!gate || gate.length === 0) return 'Sin gate: la flota no ejecuta sus tareas';
  return gate.map((g) => [g.command, ...g.args].join(' ')).join(' && ');
}

export function ProjectsSection() {
  const projects = useApp((s) => s.projects);
  const [removing, setRemoving] = useState<ProjectRecord | null>(null);

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
                onPress={() => setRemoving(p)}
              >
                <FolderX className="size-4" aria-hidden="true" />
                Quitar
              </Button>
            </div>
          ))
        )}
      </SettingsCard>
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
