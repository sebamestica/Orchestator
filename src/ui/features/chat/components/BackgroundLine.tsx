import { LoaderCircle } from 'lucide-react';

/** Texto de la línea: cuántos subagentes de la mente siguen trabajando aunque el turno haya terminado. */
export function backgroundText(count: number): string {
  return count === 1
    ? '1 agente sigue trabajando en segundo plano: la mente te responde aquí cuando termine'
    : `${count} agentes siguen trabajando en segundo plano: la mente te responde aquí cuando terminen`;
}

/** Aviso discreto encima del input mientras hay subagentes de la mente trabajando (aunque nadie mire el chat). */
export function BackgroundLine({ count }: { count: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="background-line"
      className="flex min-w-0 items-center gap-1.5 px-2 text-[0.75rem] leading-4 text-muted"
    >
      <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span className="min-w-0 truncate">{backgroundText(count)}</span>
    </div>
  );
}
