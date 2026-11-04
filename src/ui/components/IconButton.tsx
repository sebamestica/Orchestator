import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  size?: 'sm' | 'md';
  active?: boolean;
}

/** Botón de icono (patrón de studyapp: fondo solo al pasar, texto atenuado). */
export function IconButton({ label, children, size = 'md', active = false, className = '', ...rest }: IconButtonProps) {
  const box = size === 'sm' ? 'size-7' : 'size-8';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`flex ${box} shrink-0 items-center justify-center rounded-lg transition-colors duration-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-40 ${active ? 'bg-foreground/[0.08] text-foreground' : 'text-muted hover:bg-foreground/[0.06] hover:text-foreground'} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
