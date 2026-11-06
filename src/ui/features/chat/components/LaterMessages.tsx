import type { LaterMessage } from '../store.ts';

const ACTION =
  'rounded-md px-1.5 py-0.5 transition-colors duration-quick hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';

/** Resumen de los adjuntos de un pendiente (el texto puede ir vacío si solo lleva archivos). */
function attachmentsText(count: number): string {
  return count === 1 ? '1 adjunto' : `${count} adjuntos`;
}

/** Mensajes guardados con «Más tarde»: viven solo en la interfaz y se mandan o se borran a mano. */
export function LaterMessages({
  items,
  onSend,
  onDrop,
}: {
  items: readonly LaterMessage[];
  onSend: (item: LaterMessage) => void;
  onDrop: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" aria-label="Mensajes pendientes" data-testid="later-messages">
      {items.map((item) => (
        <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-xl bg-foreground/[0.04] px-3 py-1.5 text-[0.8125rem] leading-5" data-testid="later-message">
          <span className="shrink-0 text-[0.75rem] text-muted">Pendiente</span>
          <span className="selectable min-w-0 flex-1 truncate text-foreground">
            {item.text || attachmentsText(item.attachments.length)}
            {item.text && item.attachments.length > 0 ? <span className="text-muted"> · {attachmentsText(item.attachments.length)}</span> : null}
          </span>
          <button type="button" aria-label="Enviar pendiente" onClick={() => onSend(item)} className={`shrink-0 text-foreground ${ACTION}`}>
            Enviar
          </button>
          <button type="button" aria-label="Borrar pendiente" onClick={() => onDrop(item.id)} className={`shrink-0 text-muted ${ACTION}`}>
            Borrar
          </button>
        </li>
      ))}
    </ul>
  );
}
