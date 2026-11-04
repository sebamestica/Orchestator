import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

/** Superficie estática (tarjeta) con el vidrio del tema. */
export function Panel({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`glass-surface rounded-2xl border border-foreground/[0.06] bg-[var(--surface)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Tarjeta de acción (como «Clone a repo» / «Open a local folder» de la portada). */
export function ActionCard({ icon, label, hint, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; label: string; hint?: string }) {
  return (
    <button
      type="button"
      className={`group flex h-14 w-full items-center gap-3 rounded-xl bg-foreground/[0.045] px-4 text-left transition-colors duration-quick hover:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50 ${className}`}
      {...rest}
    >
      <span className="text-muted transition-colors group-hover:text-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-medium text-foreground">{label}</span>
        {hint ? <span className="block truncate text-[0.75rem] text-muted">{hint}</span> : null}
      </span>
    </button>
  );
}
