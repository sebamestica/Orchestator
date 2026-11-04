import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground/[0.05] text-muted">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[0.9375rem] font-medium text-foreground">{title}</p>
        {description ? <p className="max-w-sm text-[0.8125rem] text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
