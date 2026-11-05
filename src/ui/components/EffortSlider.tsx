import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, type JSX } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Popover,
  Slider,
  SliderFill,
  SliderThumb,
  SliderTrack,
} from 'react-aria-components';
import type { Effort } from '../../shared/api.ts';

export const EFFORT_LABELS: Readonly<Record<Effort, string>> = {
  low: 'Rápido',
  medium: 'Equilibrado',
  high: 'Profundo',
  xhigh: 'Muy profundo',
  max: 'Máximo',
};

export const EFFORT_HINTS: Readonly<Record<Effort, string>> = {
  low: 'Respuestas al instante, para preguntas puntuales.',
  medium: 'Equilibrio entre rapidez y calidad de respuesta.',
  high: 'Razonamiento detallado para tareas complejas.',
  xhigh: 'Análisis minucioso con verificación exhaustiva.',
  max: 'Piensa a fondo, tarda más y gasta más.',
};

const DEFAULT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'max'];

export interface EffortSliderProps {
  value: Effort;
  onChange: (value: Effort) => void;
  /** Niveles que ofrece, en orden (por defecto ['low', 'medium', 'high', 'max']). */
  levels?: readonly Effort[];
  isDisabled?: boolean;
}

interface EffortThumbProps {
  label: string;
  currentIndex: number;
  maxIndex: number;
  currentLevels: readonly Effort[];
  onChange: (value: Effort) => void;
  isDisabled: boolean;
}

function EffortThumb({
  label,
  currentIndex,
  maxIndex,
  currentLevels,
  onChange,
  isDisabled,
}: EffortThumbProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute('aria-valuetext', label);
    const onKey = (e: KeyboardEvent) => {
      if (isDisabled) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentIndex < maxIndex) {
          const next = currentLevels[currentIndex + 1];
          if (next) onChange(next);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentIndex > 0) {
          const prev = currentLevels[currentIndex - 1];
          if (prev) onChange(prev);
        }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [currentIndex, maxIndex, currentLevels, onChange, isDisabled, label]);

  return (
    <SliderThumb
      inputRef={inputRef}
      className="top-1/2 size-4 rounded-full border border-black/15 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.25)] transition-[left] duration-fast ease-emphasized focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground motion-reduce:transition-none cursor-grab active:cursor-grabbing disabled:cursor-not-allowed"
    />
  );
}

/**
 * Selector de esfuerzo de razonamiento al estilo ChatGPT: botón disparador compacto
 * y popover con deslizador horizontal discreto y descripción del nivel.
 */
export function EffortSlider({
  value,
  onChange,
  levels = DEFAULT_LEVELS,
  isDisabled = false,
}: EffortSliderProps): JSX.Element {
  const currentLevels = levels.length > 0 ? levels : DEFAULT_LEVELS;
  const rawIndex = currentLevels.indexOf(value);
  const currentIndex = rawIndex >= 0 ? rawIndex : 0;
  const maxIndex = Math.max(0, currentLevels.length - 1);
  const activeLevel = currentLevels[currentIndex] ?? 'medium';

  const label = EFFORT_LABELS[value] ?? EFFORT_LABELS[activeLevel];
  const hint = EFFORT_HINTS[value] ?? EFFORT_HINTS[activeLevel];

  return (
    <DialogTrigger>
      <Button
        isDisabled={isDisabled}
        aria-label={`Esfuerzo: ${label}`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-foreground/[0.08] bg-foreground/[0.045] px-2.5 text-[0.75rem] font-medium text-foreground transition-colors duration-quick hover:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
      >
        <span>
          Esfuerzo: <span className="font-semibold">{label}</span>
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted" aria-hidden="true" />
      </Button>

      <Popover
        placement="bottom start"
        className="popover z-50 w-72 rounded-xl border border-foreground/10 bg-overlay p-3.5 shadow-lg outline-none glass-surface"
      >
        <Dialog aria-label="Esfuerzo de razonamiento" className="flex flex-col gap-3 outline-none">
          <div className="flex items-center justify-between text-[0.8125rem]">
            <span className="text-[0.75rem] font-medium text-muted">Esfuerzo de razonamiento</span>
            <span className="font-semibold text-foreground">{label}</span>
          </div>

          <Slider
            aria-label="Esfuerzo de razonamiento"
            value={currentIndex}
            minValue={0}
            maxValue={maxIndex}
            step={1}
            isDisabled={isDisabled}
            onChange={(val) => {
              const nextIdx = typeof val === 'number' ? val : val[0];
              const target = currentLevels[nextIdx ?? 0];
              if (target) onChange(target);
            }}
            className="w-full py-1 outline-none"
          >
            <SliderTrack className="relative flex h-6 w-full cursor-pointer items-center outline-none">
              {/* Riel base */}
              <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-foreground/10" />

              {/* Puntos en los extremos */}
              <span
                className="pointer-events-none absolute left-0 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/25"
                aria-hidden="true"
              />
              <span
                className="pointer-events-none absolute right-0 top-1/2 size-1.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/25"
                aria-hidden="true"
              />

              {/* Relleno de color con animación suave */}
              <SliderFill
                className="rounded-full bg-accent transition-[width] duration-fast ease-emphasized motion-reduce:transition-none"
                style={{ height: '6px', top: '50%', transform: 'translateY(-50%)' }}
              />

              {/* Pulgar redondo blanco con sombra */}
              <EffortThumb
                label={label}
                currentIndex={currentIndex}
                maxIndex={maxIndex}
                currentLevels={currentLevels}
                onChange={onChange}
                isDisabled={isDisabled}
              />
            </SliderTrack>
          </Slider>

          <p className="text-[0.75rem] leading-relaxed text-muted">{hint}</p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
