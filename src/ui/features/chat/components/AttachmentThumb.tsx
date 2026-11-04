import { FileText, ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Attachment } from '../../../../shared/api.ts';
import { coreEndpoint } from '../../../api/client.ts';
import { formatBytes } from '../format.ts';

/**
 * Bytes de un adjunto como URL local (`GET /attachments/:id` necesita el token, así que no sirve un
 * `<img src>` directo). La URL se libera al desmontar.
 */
export function useAttachmentUrl(id: string, enabled = true): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!enabled) return;
    let url: string | null = null;
    let cancelled = false;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const core = coreEndpoint();
        const res = await fetch(`${core.url}/attachments/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${core.token}` },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ url, failed: false });
      } catch {
        if (!cancelled) setState({ url: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, enabled]);
  return state;
}

function ImageThumb({ attachment }: { attachment: Attachment }) {
  const { url, failed } = useAttachmentUrl(attachment.id);
  return (
    <span className="flex size-20 items-center justify-center overflow-hidden rounded-xl bg-foreground/[0.06]" title={attachment.name}>
      {url ? (
        <img src={url} alt={attachment.name} className="size-full object-cover" />
      ) : failed ? (
        <ImageOff className="size-4 text-muted" aria-label={`No se pudo cargar ${attachment.name}`} />
      ) : (
        <span className="size-full animate-pulse bg-foreground/[0.04]" aria-hidden="true" />
      )}
    </span>
  );
}

/** Adjuntos de un mensaje: miniaturas de imagen y fichas de archivo. */
export function AttachmentList({ attachments, align = 'end' }: { attachments: readonly Attachment[]; align?: 'start' | 'end' }) {
  if (attachments.length === 0) return null;
  return (
    <ul className={`flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : ''}`} aria-label="Adjuntos">
      {attachments.map((a) => (
        <li key={a.id}>
          {a.kind === 'image' ? (
            <ImageThumb attachment={a} />
          ) : (
            <span className="flex h-11 max-w-60 items-center gap-2 rounded-xl bg-foreground/[0.06] px-3 text-[0.8125rem]" title={a.path}>
              <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 truncate">{a.name}</span>
              <span className="shrink-0 text-[0.75rem] text-muted">{formatBytes(a.size)}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
