import type { ActivityRow } from './model.ts';
import './activity.css';

export function ActivityRowView({ name, row, quota }: { name: string; row: ActivityRow; quota?: string | undefined }) {
  const color = row.status === 'Error' || row.status === 'Detenido' ? 'bg-red-500' : row.status === 'En espera' || row.status === 'Sin señal' ? 'bg-amber-500' : row.active ? 'bg-emerald-500' : 'bg-foreground/25';
  // Solo informa: sin foco propio (la lista que la contiene es la única parada de Tab) y los cambios salen por aria-live.
  return <article aria-label={name} className="relative min-w-0 overflow-hidden rounded-xl bg-foreground/[0.035] px-3 py-3">
    <div className="flex items-center gap-2.5">
      <span aria-hidden="true" className={`relative flex size-4 shrink-0 items-center justify-center ${row.active && row.thinking ? 'animate-spin motion-reduce:animate-none' : ''}`}>
        {row.active && row.thinking && <span className="absolute inset-0 rounded-full border border-emerald-500/25 border-t-emerald-500" />}
        <span className={`size-1.5 rounded-full ${color} ${row.active && !row.thinking ? 'animate-pulse motion-reduce:animate-none' : ''}`} />
      </span>
      <h3 className="min-w-0 flex-1 break-words text-sm font-medium">{name}</h3>
    </div>
    <div aria-live="polite" aria-atomic="true" className="pl-[26px]">
      <div key={`${row.status}:${row.line}`} className="agent-change motion-reduce:animate-none motion-reduce:transform-none">
        <p className="mt-1 text-xs font-medium">{row.status}</p>
        <p className="mt-1 break-words text-xs leading-relaxed text-muted">{row.line}</p>
      </div>
      {quota && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{quota}</p>}
    </div>
    {row.active && <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px overflow-hidden bg-emerald-500/10"><div className="agent-activity h-full w-1/3 bg-emerald-500/60 motion-reduce:animate-none" /></div>}
  </article>;
}
