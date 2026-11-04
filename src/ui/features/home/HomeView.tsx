import { FolderOpen, FolderGit2, ListPlus, MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';
import { navigate } from '../../app/routes.ts';
import { ActionCard } from '../../components/Card.tsx';
import { useApp } from '../../store/app.ts';
import { AddProjectDialog } from '../projects/AddProjectDialog.tsx';

function lastUsed(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  return `Hace ${days} días`;
}

/** Portada: retomar un proyecto o empezar algo nuevo. */
export function HomeView() {
  const projects = useApp((s) => s.projects);
  const [adding, setAdding] = useState(false);
  const recent = [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);

  return (
    <div className="animate-enter flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[38rem]">
        <h1 className="mb-4 text-[0.9375rem] font-medium text-foreground">Retoma donde quedaste</h1>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ActionCard icon={<FolderOpen className="size-[18px]" />} label="Abrir una carpeta local" onClick={() => setAdding(true)} />
          <ActionCard icon={<MessageSquarePlus className="size-[18px]" />} label="Agente suelto" onClick={() => navigate({ name: 'standalone' })} />
          <ActionCard icon={<ListPlus className="size-[18px]" />} label="Darle una tarea a mano" onClick={() => navigate({ name: 'board' })} />
          <ActionCard icon={<FolderGit2 className="size-[18px]" />} label="Clonar un repo" hint="Próximamente" disabled />
        </div>
        {recent.length ? (
          <ul className="mt-4 flex flex-col">
            {recent.map((p) => (
              <li key={p.id}>
                <a href={`#/p/${encodeURIComponent(p.id)}`} className="flex h-11 items-center gap-3 rounded-xl px-4 text-[0.9375rem] transition-colors hover:bg-foreground/[0.045]">
                  <FolderOpen className="size-[18px] text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span className="truncate text-[0.75rem] text-muted">{p.repoPath}</span>
                  <span className="w-20 shrink-0 text-right text-[0.75rem] text-muted">{lastUsed(p.createdAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <AddProjectDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
