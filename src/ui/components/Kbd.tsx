import type { ReactNode } from 'react';

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] px-1.5 font-mono text-[0.6875rem] text-muted">
      {children}
    </kbd>
  );
}
