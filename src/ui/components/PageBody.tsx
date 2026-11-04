import type { ReactNode } from 'react';

interface PageBodyProps {
  children: ReactNode;
  width?: 'default' | 'split' | 'wide' | 'full';
}

const WIDTH = {
  default: 'max-w-3xl',
  split: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
} as const;

/** Contenedor de página con ancho máximo (como PageBody de studyapp). */
export function PageBody({ children, width = 'default' }: PageBodyProps) {
  return <div className={`mx-auto w-full ${WIDTH[width]} px-4 py-8 sm:px-6`}>{children}</div>;
}

/** Encabezado de página: título y acciones a la derecha. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.375rem] font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-[0.875rem] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
