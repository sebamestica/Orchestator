import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface NavItemProps {
  icon: LucideIcon;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  /** Acciones que aparecen al pasar el ratón (iconos pequeños). */
  actions?: ReactNode;
  badge?: ReactNode;
}

/** Fila de navegación de la barra lateral (h-9, indicador suave en la activa). */
export function NavItem({ icon: Icon, label, href, onClick, active = false, actions, badge }: NavItemProps) {
  const body = (
    <>
      {active ? <span aria-hidden="true" className="nav-indicator" /> : null}
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </>
  );
  const cls = `relative isolate flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-[0.875rem] transition-colors duration-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${active ? 'font-medium text-foreground' : 'text-muted hover:text-foreground'}`;
  return (
    <li className="group relative flex items-center">
      {href ? (
        <a href={href} className={cls} aria-current={active ? 'page' : undefined}>
          {body}
        </a>
      ) : (
        <button type="button" onClick={onClick} className={`${cls} text-left`} aria-current={active ? 'page' : undefined}>
          {body}
        </button>
      )}
      {actions ? <div className="reveal absolute right-1 flex items-center gap-0.5">{actions}</div> : null}
    </li>
  );
}
