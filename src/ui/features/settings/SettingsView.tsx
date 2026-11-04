/** Ajustes de Berland: navegación de secciones a la izquierda y contenido a la derecha. */
import { Bot, Brain, Database, FolderGit2, Puzzle, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { routeHash, type SettingsSection } from '../../app/routes.ts';
import { PageBody, PageHeader } from '../../components/PageBody.tsx';
import { AgentsSection } from './AgentsSection.tsx';
import { GeneralSection } from './GeneralSection.tsx';
import { MemorySection } from './MemorySection.tsx';
import { MindSection } from './MindSection.tsx';
import { ProjectsSection } from './ProjectsSection.tsx';
import { SkillsSection } from './SkillsSection.tsx';

export interface SettingsViewProps {
  section: SettingsSection;
}

const SECTIONS: readonly { id: SettingsSection; label: string; icon: LucideIcon; description: string }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, description: 'Apariencia y reparto de la flota.' },
  { id: 'mente', label: 'Mente y subagentes', icon: Brain, description: 'Quién orquesta, con qué modelo y a quién delega.' },
  { id: 'agentes', label: 'Agentes', icon: Bot, description: 'Agentes registrados, claves y pruebas.' },
  { id: 'proyectos', label: 'Proyectos', icon: FolderGit2, description: 'Carpetas que conoce Berland.' },
  { id: 'memoria', label: 'Memoria', icon: Database, description: 'Vista previa del contexto de cada proyecto.' },
  { id: 'skills', label: 'Skills', icon: Puzzle, description: 'Skills instaladas y en cuarentena.' },
];

function SectionContent({ section }: SettingsViewProps) {
  switch (section) {
    case 'general':
      return <GeneralSection />;
    case 'mente':
      return <MindSection />;
    case 'agentes':
      return <AgentsSection />;
    case 'proyectos':
      return <ProjectsSection />;
    case 'memoria':
      return <MemorySection />;
    case 'skills':
      return <SkillsSection />;
  }
}

export default function SettingsView({ section }: SettingsViewProps) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Secciones de ajustes" className="w-56 shrink-0 overflow-y-auto border-r border-foreground/[0.06] px-3 py-6">
        <p className="px-3 pb-2 text-[0.75rem] font-medium uppercase tracking-wide text-muted">Ajustes</p>
        <ul className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => {
            const active = s.id === section;
            const Icon = s.icon;
            return (
              <li key={s.id}>
                <a
                  href={routeHash({ name: 'settings', section: s.id })}
                  aria-current={active ? 'page' : undefined}
                  className={`relative isolate flex h-11 items-center gap-2.5 rounded-lg px-3 text-[0.875rem] transition-colors duration-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground motion-reduce:transition-none ${active ? 'font-medium text-foreground' : 'text-muted hover:text-foreground'}`}
                >
                  {active ? <span aria-hidden="true" className="nav-indicator" /> : null}
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{s.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageBody>
          {current ? <PageHeader title={current.label} description={current.description} /> : null}
          <SectionContent section={section} />
        </PageBody>
      </div>
    </div>
  );
}
