import { Compass, ListChecks, MessageSquareText, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { APP_NAME } from '../format.ts';

interface Suggestion {
  icon: LucideIcon;
  text: string;
}

export function suggestionsFor(projectName: string | null): Suggestion[] {
  if (projectName === null) {
    return [
      { icon: Compass, text: 'Explícame qué hay en esta carpeta y cómo está organizada' },
      { icon: Search, text: 'Revisa el código y sugiere mejoras concretas' },
      { icon: ListChecks, text: 'Ayúdame a planear una tarea nueva paso a paso' },
    ];
  }
  return [
    { icon: Compass, text: 'Revisa el estado del proyecto y propón los siguientes pasos' },
    { icon: ListChecks, text: `Lee el plan de ${projectName} y dime qué tareas faltan y en qué orden` },
    { icon: Search, text: 'Busca errores o deuda técnica y propón tareas para resolverlos' },
  ];
}

/** Saludo del chat vacío con tres primeros mensajes sugeridos según el proyecto. */
export function EmptyChat({ projectName, onPick, isDisabled = false }: { projectName: string | null; onPick: (text: string) => void; isDisabled?: boolean }) {
  return (
    <div className="animate-enter flex flex-1 flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground/[0.05] text-muted">
        <Sparkles className="size-5" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[1.375rem] font-semibold tracking-tight text-foreground">
          {projectName ? `¿Qué hacemos en ${projectName}?` : '¿En qué te ayudo?'}
        </h1>
        <p className="mx-auto max-w-md text-[0.875rem] text-muted">
          {projectName
            ? `${APP_NAME} lee la carpeta, propone tareas y las reparte a la flota cuando las apruebas.`
            : `${APP_NAME} trabaja en una carpeta suelta: lee, responde y propone, sin delegar a la flota.`}
        </p>
      </div>
      <ul className="flex w-full max-w-[34rem] flex-col gap-2">
        {suggestionsFor(projectName).map((s) => (
          <li key={s.text}>
            <button
              type="button"
              disabled={isDisabled}
              onClick={() => onPick(s.text)}
              className="group flex min-h-11 w-full items-center gap-3 rounded-xl bg-foreground/[0.045] px-4 py-2.5 text-left text-[0.875rem] text-foreground transition-colors duration-quick hover:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50"
            >
              <s.icon className="size-4 shrink-0 text-muted transition-colors group-hover:text-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">{s.text}</span>
              <MessageSquareText className="size-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
