import { CircleUserRound, Folder, KanbanSquare, MessageSquarePlus, MoreHorizontal, Plus, Puzzle, Settings } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../components/IconButton.tsx';
import { NavItem } from '../components/NavItem.tsx';
import { AddProjectDialog } from '../features/projects/AddProjectDialog.tsx';
import { useApp } from '../store/app.ts';
import { PROFILE_HASH, routeHash, type Route } from './routes.ts';

function StatusDot() {
  const core = useApp((s) => s.core);
  const live = useApp((s) => s.live);
  const ok = core === 'ready' && live === 'open';
  const label = core !== 'ready' ? 'Núcleo sin conexión' : live === 'open' ? 'Conectado en vivo' : 'Reconectando…';
  return (
    <span className="flex items-center gap-2 px-2.5 text-[0.75rem] text-muted" title={label}>
      <span className={`size-1.5 rounded-full ${ok ? 'bg-success' : 'bg-warning'}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function Sidebar({ route }: { route: Route }) {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const projects = useApp((s) => s.projects);
  const [adding, setAdding] = useState(false);
  const projectId = route.name === 'project' || route.name === 'board' ? route.projectId : undefined;

  return (
    <aside inert={collapsed} data-state={collapsed ? 'collapsed' : 'open'} className="app-sidebar flex shrink-0 flex-col overflow-hidden">
      <div className="flex min-h-0 w-[var(--sidebar-width)] flex-1 flex-col px-3 pb-3">
        <a href="#/" className="flex h-10 items-center px-2.5 text-[0.9375rem] font-semibold tracking-tight text-foreground">
          Berland
        </a>

        <ul className="mt-1 flex flex-col gap-0.5">
          <NavItem icon={MessageSquarePlus} label="Agente suelto" href={routeHash({ name: 'standalone' })} active={route.name === 'standalone'} />
          <NavItem icon={KanbanSquare} label="Tablero" href={routeHash({ name: 'board' })} active={route.name === 'board' && !route.projectId} />
          <NavItem icon={Puzzle} label="Plugins" href={routeHash({ name: 'plugins' })} active={route.name === 'plugins'} />
        </ul>

        <div className="mt-5 flex h-8 items-center justify-between pl-2.5 pr-1">
          <span className="text-[0.8125rem] font-medium text-muted">Proyectos</span>
          <IconButton label="Agregar proyecto (carpeta)" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {projects.map((p) => (
            <NavItem
              key={p.id}
              icon={Folder}
              label={p.name}
              href={routeHash({ name: 'project', projectId: p.id })}
              active={projectId === p.id}
              actions={
                <>
                  <a href={routeHash({ name: 'board', projectId: p.id })} aria-label={`Tablero de ${p.name}`} title="Tablero" className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-foreground/[0.08] hover:text-foreground">
                    <KanbanSquare className="size-3.5" aria-hidden="true" />
                  </a>
                  <a href={routeHash({ name: 'settings', section: 'proyectos' })} aria-label={`Opciones de ${p.name}`} title="Opciones" className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-foreground/[0.08] hover:text-foreground">
                    <MoreHorizontal className="size-3.5" aria-hidden="true" />
                  </a>
                </>
              }
            />
          ))}
          {projects.length === 0 ? <li className="px-2.5 py-2 text-[0.8125rem] text-muted">Agrega una carpeta para empezar.</li> : null}
        </ul>

        <div className="mt-2 flex flex-col gap-1 border-t border-foreground/[0.06] pt-2">
          <StatusDot />
          <ul>
            <NavItem icon={CircleUserRound} label="Perfil" href={PROFILE_HASH} active={route.name === 'settings' && route.section === 'uso'} />
            <NavItem icon={Settings} label="Ajustes" href={routeHash({ name: 'settings', section: 'general' })} active={route.name === 'settings' && route.section !== 'uso'} />
          </ul>
        </div>
      </div>
      <AddProjectDialog open={adding} onClose={() => setAdding(false)} />
    </aside>
  );
}
