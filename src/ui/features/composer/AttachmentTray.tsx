/**
 * Bandeja de adjuntos del composer: miniatura de cada imagen y ficha de cada archivo, con su botón «quitar» en la
 * esquina. Tomada de studyapp (`shared/components/AttachmentTray` y `FileThumbnail`).
 */
import { CircleAlert, LoaderCircle, X } from 'lucide-react';
import { formatBytes } from '../chat/format.ts';
import { fileGlyphOf } from './file-glyph.ts';
import type { PendingAttachment } from './useAttachments.ts';

interface AttachmentTrayProps {
  items: readonly PendingAttachment[];
  onRemove: (id: number) => void;
  isDisabled?: boolean;
}

const UPLOADING = 'Subiendo…';

function Spinner({ className = '' }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={`animate-spin motion-reduce:animate-none ${className}`} />;
}

function ImageChip({ item }: { item: PendingAttachment }) {
  const uploading = !item.attachment && !item.error;
  return (
    <div aria-busy={uploading} className={`relative size-16 overflow-hidden rounded-2xl border bg-foreground/[0.04] ${item.error ? 'border-danger/60' : 'border-foreground/10'}`}>
      <img src={item.preview} alt={item.file.name} className="size-full object-cover" />
      {uploading ? (
        <span role="status" className="absolute inset-0 flex items-center justify-center bg-canvas/50">
          <Spinner className="size-5 text-foreground" />
          <span className="sr-only">{UPLOADING}</span>
        </span>
      ) : null}
      {item.error ? (
        <span className="absolute inset-0 flex items-center justify-center bg-danger/20">
          <CircleAlert aria-hidden="true" className="size-5 text-danger" />
        </span>
      ) : null}
    </div>
  );
}

function FileChip({ item }: { item: PendingAttachment }) {
  const { Icon, className } = fileGlyphOf(item.file.name);
  const uploading = !item.attachment && !item.error;
  return (
    <div aria-busy={uploading} className={`flex h-16 w-52 items-center gap-2.5 rounded-2xl border bg-foreground/[0.04] px-3 ${item.error ? 'border-danger/60' : 'border-foreground/10'}`}>
      <Icon aria-hidden="true" className={`size-6 shrink-0 ${className}`} />
      <div className="min-w-0">
        <p className="truncate text-[0.8125rem] text-foreground">{item.file.name}</p>
        {uploading ? (
          <span role="status" className="flex items-center gap-1 text-[0.75rem] text-muted"><Spinner className="size-3" />{UPLOADING}</span>
        ) : item.error ? (
          <span className="text-[0.75rem] text-danger">No se pudo adjuntar</span>
        ) : (
          <span className="text-[0.75rem] text-muted">{formatBytes(item.file.size)}</span>
        )}
      </div>
    </div>
  );
}

export function AttachmentTray({ items, onRemove, isDisabled = false }: AttachmentTrayProps) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Adjuntos" className="flex gap-2 overflow-x-auto px-1.5 pb-1 pt-1.5">
      {items.map((item) => (
        <li key={item.id} className="relative shrink-0" title={item.file.name}>
          {item.preview ? <ImageChip item={item} /> : <FileChip item={item} />}
          <button
            type="button"
            aria-label={`Quitar ${item.file.name}`}
            disabled={isDisabled}
            onClick={() => onRemove(item.id)}
            className="glass-surface absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full border border-foreground/10 bg-[var(--background)] text-muted shadow-sm transition-colors duration-quick hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-40 motion-reduce:transition-none"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
