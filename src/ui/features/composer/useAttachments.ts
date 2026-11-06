import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENT_BYTES, attachmentSchema } from '../../../shared/api.ts';
import type { Attachment } from '../../../shared/api.ts';

/** Adjunto en la bandeja del composer: el archivo local, su miniatura y, al terminar de subir, el adjunto del núcleo. */
export interface PendingAttachment {
  id: number;
  file: File;
  /** URL local (`blob:`) de la miniatura; solo imágenes. */
  preview?: string;
  attachment?: Attachment;
  error?: string;
}

export const MAX_ATTACHMENTS = 20;
const UPLOAD_ERROR = 'El servicio puede no estar disponible. Quita el archivo y vuelve a intentarlo.';

export function useAttachments(onAttach: (file: File) => Promise<Attachment>) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState('');
  const current = useRef<PendingAttachment[]>([]);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const upload = useRef(onAttach);
  upload.current = onAttach;

  const update = useCallback((next: PendingAttachment[]) => {
    current.current = next;
    if (mounted.current) setItems(next);
  }, []);
  // El aviso de un archivo rechazado deja de ser cierto al vaciar o quitar: se va con ellos.
  const clear = useCallback(() => {
    for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview);
    update([]);
    setNotice('');
  }, [update]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview);
      current.current = [];
    };
  }, []);

  const add = useCallback((files: Iterable<File>) => {
    setNotice('');
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setNotice('Cada archivo debe pesar como máximo 20 MB.');
        continue;
      }
      if (current.current.length >= MAX_ATTACHMENTS) {
        setNotice(`Puedes adjuntar como máximo ${MAX_ATTACHMENTS} archivos.`);
        break;
      }
      const item: PendingAttachment = { id: ++sequence.current, file };
      if (file.type.startsWith('image/')) item.preview = URL.createObjectURL(file);
      update([...current.current, item]);
      void (async () => {
        try {
          const attachment = attachmentSchema.parse(await upload.current(file));
          if (mounted.current) update(current.current.map((entry) => entry.id === item.id ? { ...entry, attachment } : entry));
        } catch {
          if (mounted.current) update(current.current.map((entry) => entry.id === item.id ? { ...entry, error: UPLOAD_ERROR } : entry));
        }
      })();
    }
  }, [update]);

  const remove = useCallback((id: number) => {
    const item = current.current.find((entry) => entry.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    update(current.current.filter((entry) => entry.id !== id));
    setNotice('');
  }, [update]);
  const dismissNotice = useCallback(() => setNotice(''), []);

  return { items, notice, add, remove, clear, dismissNotice, busy: items.some((item) => !item.attachment && !item.error) };
}
