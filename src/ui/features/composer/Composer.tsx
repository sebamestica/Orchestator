import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Popover, Spinner } from '@heroui/react';
import { ArrowUp, FileIcon, Paperclip, Plus, Square, Upload, X } from 'lucide-react';
import { nextMindMode } from '../../../shared/api.ts';
import type { Attachment, MindMode } from '../../../shared/api.ts';
import { Kbd } from '../../components/Kbd.tsx';
import { useAttachments } from './useAttachments.ts';

export interface ComposerProps {
  placeholder: string;
  mode: MindMode;
  onModeChange: (mode: MindMode) => void;
  /** Sube o registra un archivo y devuelve el adjunto. */
  onAttach: (file: File) => Promise<Attachment>;
  onSubmit: (turn: { text: string; attachments: Attachment[] }) => boolean | Promise<boolean>;
  isStreaming?: boolean;
  onStop?: () => void;
  isDisabled?: boolean;
  /** `false`: la vista dibuja su propia ficha de modo (el atajo Shift+Tab del campo sigue activo). */
  showModeChip?: boolean;
}

export function Composer({ placeholder, mode, onModeChange, onAttach, onSubmit, isStreaming = false, onStop, isDisabled = false, showModeChip = true }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const composing = useRef(false);
  const attachments = useAttachments(onAttach);
  const locked = isDisabled || sending;
  const canSend = !locked && !isStreaming && !attachments.busy
    && !attachments.items.some((item) => item.error)
    && (text.trim() !== '' || attachments.items.length > 0);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 192)}px`;
  }, [text]);

  useEffect(() => {
    if (!isStreaming) return;
    const stop = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onStop?.();
    };
    window.addEventListener('keydown', stop);
    return () => window.removeEventListener('keydown', stop);
  }, [isStreaming, onStop]);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (!locked) setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (!locked) attachments.add(Array.from(event.dataTransfer?.files ?? []));
    };
    const reset = () => { depth = 0; setDragging(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('blur', reset);
    };
  }, [locked, attachments.add]);

  const send = async () => {
    if (!canSend || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError('');
    try {
      const ready = attachments.items.flatMap((item) => item.attachment ? [item.attachment] : []);
      if (await onSubmit({ text, attachments: ready })) {
        setText('');
        attachments.clear();
      }
    } catch {
      setError('No se pudo enviar. El servicio puede no estar disponible. Vuelve a intentarlo.');
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };
  const modeLabel = { plan: 'Plan', auto: 'Auto', bypass: 'Bypass' }[mode];
  const modeColor = { plan: 'text-foreground', auto: 'text-success', bypass: 'text-danger' }[mode];

  return (
    <form className="relative flex flex-col gap-2 rounded-[1.625rem] bg-foreground/[0.06] p-2 focus-within:ring-1 focus-within:ring-foreground/20" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {attachments.items.length > 0 && <ul aria-label="Adjuntos" className="flex max-h-48 flex-wrap gap-2 overflow-y-auto px-2">
        {attachments.items.map((item) => <li key={item.id} className="flex max-w-full items-center gap-2 rounded-xl border border-foreground/[0.06] bg-foreground/[0.045] p-2">
          {item.preview ? <img src={item.preview} alt={item.file.name} className="size-12 rounded-lg object-cover" /> : <FileIcon aria-hidden="true" className="size-5 shrink-0" />}
          <div className="min-w-0"><p className="truncate text-sm">{item.file.name}</p>
            {!item.attachment && !item.error && <span role="status" className="flex items-center gap-1 text-xs text-muted"><Spinner size="sm" />Subiendo…</span>}
            {item.error && <p role="alert" className="max-w-64 text-xs text-danger">{item.error}</p>}
          </div>
          <Button type="button" isIconOnly variant="ghost" size="sm" aria-label={`Quitar ${item.file.name}`} isDisabled={locked} onPress={() => attachments.remove(item.id)}><X className="size-4" aria-hidden="true" /></Button>
        </li>)}
      </ul>}
      {(attachments.notice || error) && <p role="alert" className="px-3 text-sm text-danger">{attachments.notice || error}</p>}
      <div className="flex items-end gap-2">
        <Popover isOpen={menuOpen} onOpenChange={setMenuOpen}>
          <Button type="button" isIconOnly variant="ghost" aria-label="Añadir adjunto" isDisabled={locked} className="size-9 shrink-0 rounded-full"><Plus className="size-5" aria-hidden="true" /></Button>
          <Popover.Content placement="top start"><Popover.Dialog aria-label="Adjuntar">
            <Button type="button" variant="ghost" onPress={() => { setMenuOpen(false); fileInput.current?.click(); }}><Paperclip aria-hidden="true" className="size-4" />Adjuntar archivo</Button>
          </Popover.Dialog></Popover.Content>
        </Popover>
        <textarea ref={textarea} value={text} rows={1} placeholder={placeholder} aria-label="Mensaje" disabled={locked}
          className="max-h-48 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-base leading-6 text-foreground placeholder:text-muted focus:outline-none"
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); onModeChange(nextMindMode(mode)); }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            if (!locked) attachments.add(files);
          }} />
        <Button type={isStreaming ? 'button' : 'submit'} isIconOnly aria-label={isStreaming ? 'Detener respuesta' : 'Enviar mensaje'}
          isDisabled={isStreaming ? !onStop : !canSend} onPress={isStreaming ? onStop : undefined}
          className="size-9 shrink-0 rounded-full bg-foreground text-canvas">
          {isStreaming ? <Square aria-hidden="true" className="size-4" /> : <ArrowUp aria-hidden="true" className="size-5" />}
        </Button>
      </div>
      {showModeChip ? (
        <Button type="button" variant="ghost" size="sm" isDisabled={locked} aria-label={`Cambiar modo: ${modeLabel}`} onPress={() => onModeChange(nextMindMode(mode))} className={`w-fit rounded-full ${modeColor}`}>
          {modeLabel}<Kbd>Shift+Tab</Kbd>
        </Button>
      ) : null}
      <input ref={fileInput} type="file" multiple hidden tabIndex={-1} aria-label="Seleccionar archivos" disabled={locked} onChange={(event) => {
        attachments.add(Array.from(event.target.files ?? []));
        event.target.value = '';
      }} />
      {dragging && createPortal(<div style={{ position: 'fixed' }} className="drop-overlay pointer-events-none inset-0 z-50 flex flex-col items-center justify-center gap-4" role="status"><Upload aria-hidden="true" className="size-12" /><p>Suelta para adjuntar</p></div>, document.body)}
    </form>
  );
}
