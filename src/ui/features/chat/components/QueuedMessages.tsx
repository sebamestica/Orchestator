import { X } from 'lucide-react';
import type { QueuedChatMessage } from '../../../../shared/api.ts';
import { AttachmentList } from './AttachmentThumb.tsx';

/**
 * Mensajes del usuario que esperan a que termine el turno en curso («Al terminar»): aún no están en el hilo, el núcleo
 * los manda solos, de a uno y en orden. Se pueden quitar mientras esperan.
 */
export function QueuedMessages({ queued, onRemove }: { queued: readonly QueuedChatMessage[]; onRemove: (id: string) => void }) {
  if (queued.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-4" data-testid="queued-messages">
      {queued.map((item) => (
        <div key={item.id} className="flex max-w-[78%] flex-col items-end gap-1.5" data-testid="queued-message">
          <AttachmentList attachments={item.attachments} />
          {item.text ? (
            <div className="selectable whitespace-pre-wrap break-words rounded-2xl border border-dashed border-foreground/20 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-muted">
              {item.text}
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-[0.75rem] leading-4 text-muted">
            <span>En cola</span>
            <button
              type="button"
              aria-label="Quitar de la cola"
              onClick={() => onRemove(item.id)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors duration-quick hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            >
              <X className="size-3" aria-hidden="true" />
              Quitar
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
