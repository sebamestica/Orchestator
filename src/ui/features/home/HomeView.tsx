import { FolderOpen, FolderGit2, ListPlus, MessageSquarePlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { api } from '../../api/client.ts';
import { lastActivity } from '../../api/tasks.ts';
import type { ProjectRecord, TaskRecord } from '../../api/types.ts';
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

/** De `GET /chats` solo interesa a qué proyecto pertenece cada chat y cuándo se tocó por última vez. */
const chatActivityResponse = z.object({
  chats: z.array(z.object({ projectId: z.string().nullable(), updatedAt: z.string() })),
});
type ChatActivity = z.infer<typeof chatActivityResponse>['chats'][number];

/** Chats de todos los proyectos; si el núcleo no responde, la portada se arregla con tareas y fecha de alta. */
function useChatActivity(): ChatActivity[] {
  const [chats, setChats] = useState<ChatActivity[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .get<unknown>('/chats')
      .then((res) => {
        const parsed = chatActivityResponse.safeParse(res);
        if (alive && parsed.success) setChats(parsed.data.chats);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return chats;
}

function later(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

interface RecentProject {
  project: ProjectRecord;
  lastUsedAt: string;
}

/** Los 6 proyectos usados más recientemente: la fecha mayor entre su alta, sus tareas y sus chats. */
function recentProjects(projects: readonly ProjectRecord[], tasks: readonly TaskRecord[], chats: readonly ChatActivity[]): RecentProject[] {
  const lastUse = new Map(projects.map((p) => [p.id, p.createdAt]));
  const touch = (projectId: string | null, at: string) => {
    const current = projectId ? lastUse.get(projectId) : undefined;
    if (projectId && current) lastUse.set(projectId, later(current, at));
  };
  for (const t of tasks) touch(t.task.projectId, lastActivity(t));
  for (const c of chats) touch(c.projectId, c.updatedAt);
  return projects
    .map((project) => ({ project, lastUsedAt: lastUse.get(project.id) ?? project.createdAt }))
    .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
    .slice(0, 6);
}

/** Portada: retomar un proyecto o empezar algo nuevo. */
export function HomeView() {
  const projects = useApp((s) => s.projects);
  const tasks = useApp((s) => s.tasks);
  const chats = useChatActivity();
  const [adding, setAdding] = useState(false);
  const recent = useMemo(() => recentProjects(projects, Object.values(tasks), chats), [projects, tasks, chats]);

  return (
    <div className="animate-enter flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[38rem]">
        <h1 className="mb-4 text-[0.9375rem] font-medium text-foreground">Retoma donde quedaste</h1>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ActionCard icon={<FolderOpen className="size-[18px]" />} label="Abrir una carpeta local" onClick={() => setAdding(true)} />
          <ActionCard icon={<MessageSquarePlus className="size-[18px]" />} label="Conversaciones" onClick={() => navigate({ name: 'standalone' })} />
          <ActionCard icon={<ListPlus className="size-[18px]" />} label="Darle una tarea a mano" onClick={() => navigate({ name: 'board', nueva: true })} />
          <ActionCard icon={<FolderGit2 className="size-[18px]" />} label="Clonar un repo" hint="Próximamente" disabled />
        </div>
        {recent.length ? (
          <ul className="mt-4 flex flex-col">
            {recent.map(({ project: p, lastUsedAt }) => (
              <li key={p.id}>
                <a href={`#/p/${encodeURIComponent(p.id)}`} className="flex h-11 items-center gap-3 rounded-xl px-4 text-[0.9375rem] transition-colors hover:bg-foreground/[0.045]">
                  <FolderOpen className="size-[18px] text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span className="truncate text-[0.75rem] text-muted">{p.repoPath}</span>
                  <span className="w-20 shrink-0 text-right text-[0.75rem] text-muted">{lastUsed(lastUsedAt)}</span>
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
