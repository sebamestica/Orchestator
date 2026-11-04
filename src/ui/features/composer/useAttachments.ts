import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENT_BYTES, attachmentSchema } from '../../../shared/api.ts';
import type { Attachment } from '../../../shared/api.ts';

interface Item {
  id: number;
  file: File;
  preview?: string;
  attachment?: Attachment;
  error?: string;
}

export function useAttachments(onAttach: (file: File) => Promise<Attachment>) {
  const [items, setItems] = useState<Item[]>([]);
  const [notice, setNotice] = useState('');
  const current = useRef<Item[]>([]);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const upload = useRef(onAttach);
  upload.current = onAttach;

  const update = useCallback((next: Item[]) => {
    current.current = next;
    if (mounted.current) setItems(next);
  }, []);
  const clear = useCallback(() => {
    for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview);
    update([]);
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
      if (current.current.length >= 20) {
        setNotice('Puedes adjuntar como máximo 20 archivos.');
        break;
      }
      const item: Item = { id: ++sequence.current, file };
      if (file.type.startsWith('image/')) item.preview = URL.createObjectURL(file);
      update([...current.current, item]);
      void (async () => {
        try {
          const attachment = attachmentSchema.parse(await upload.current(file));
          if (mounted.current) update(current.current.map((entry) => entry.id === item.id ? { ...entry, attachment } : entry));
        } catch {
          if (mounted.current) update(current.current.map((entry) => entry.id === item.id
            ? { ...entry, error: 'No se pudo adjuntar. El servicio puede no estar disponible. Quita el archivo y vuelve a intentarlo.' }
            : entry));
        }
      })();
    }
  }, [update]);

  const remove = (id: number) => {
    const item = current.current.find((entry) => entry.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    update(current.current.filter((entry) => entry.id !== id));
  };

  return { items, notice, add, remove, clear, busy: items.some((item) => !item.attachment && !item.error) };
}
