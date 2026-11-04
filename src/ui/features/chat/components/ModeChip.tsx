import { Brain } from 'lucide-react';
import { nextMindMode, type MindMode } from '../../../../shared/api.ts';
import { Kbd } from '../../../components/Kbd.tsx';
import { MODE_INFO } from '../format.ts';

interface ModeChipProps {
  mode: MindMode;
  onChange: (mode: MindMode) => void;
  /** Agente que hace de mente (nombre visible) y su modelo, si se conoce. */
  mind: { name: string; model?: string } | null;
  isDisabled?: boolean;
}

/** Ficha del modo de la mente (Plan neutra, Auto verde, Bypass roja): clic o Shift+Tab para cambiar. */
export function ModeChip({ mode, onChange, mind, isDisabled = false }: ModeChipProps) {
  const info = MODE_INFO[mode];
  const next = nextMindMode(mode);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[0.75rem]">
      <button
        type="button"
        disabled={isDisabled}
        onClick={() => onChange(next)}
        aria-label={`Modo ${info.label}. Cambiar a ${MODE_INFO[next].label} (Shift+Tab)`}
        title={`Cambiar a ${MODE_INFO[next].label}`}
        data-testid="mode-chip"
        data-mode={mode}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-foreground/[0.045] px-2.5 font-medium transition-colors duration-quick hover:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50 ${info.tone}`}
      >
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
        {info.label}
      </button>
      <span className="min-w-0 flex-1 truncate text-muted">{info.hint}</span>
      <span className="hidden shrink-0 items-center gap-1 text-muted sm:flex">
        <Kbd>Shift+Tab</Kbd>
      </span>
      {mind ? (
        <span className="flex shrink-0 items-center gap-1 text-muted" title={mind.model ? `${mind.name} · ${mind.model}` : mind.name}>
          <Brain className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Mente:</span>
          <span className="max-w-40 truncate">{mind.name}</span>
          {mind.model ? <span className="hidden max-w-40 truncate font-mono text-[0.6875rem] md:inline">{mind.model}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
