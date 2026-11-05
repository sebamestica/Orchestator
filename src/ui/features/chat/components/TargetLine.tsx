import { CloudUpload, HardDrive } from 'lucide-react';
import { draftLineParts, targetLineParts, targetLineText, useChangesTarget } from '../target-line.ts';

interface TargetLineProps {
  /** Chat activo; `null` mientras no hay conversación. */
  chatId: string | null;
  /** Conversación sin proyecto con carpeta elegida: solo «Local · <carpeta>». */
  standalone: boolean;
  /** Sin chat todavía: carpeta del proyecto donde arrancará la conversación nueva (siempre en local). */
  draft?: { path: string; worktrees: boolean } | null;
}

/**
 * Línea discreta encima del input: si los cambios quedan en local o se subirían a un repositorio. La ruta o la URL
 * se trunca y su `title` la muestra completa. Mientras carga (o si falla) queda vacía, con su alto reservado.
 */
export function TargetLine({ chatId, standalone, draft = null }: TargetLineProps) {
  const { target } = useChangesTarget(chatId);
  const parts = target ? targetLineParts(target, { standalone }) : chatId ? null : draftLineParts(draft);
  const Icon = parts?.kind === 'remote' ? CloudUpload : HardDrive;
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      data-testid="target-line"
      data-kind={parts?.kind ?? 'none'}
      title={parts ? targetLineText(parts) : undefined}
      className="flex h-4 min-w-0 items-center gap-1.5 overflow-hidden px-2 text-[0.75rem] leading-4 text-muted"
    >
      {parts ? (
        <>
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0">
            <span className="shrink-0 whitespace-pre">{parts.lead}</span>
            <span className="min-w-0 truncate" title={parts.place} data-testid="target-place">
              {parts.place}
            </span>
            {parts.tail ? <span className="shrink-0 whitespace-pre">{parts.tail}</span> : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
