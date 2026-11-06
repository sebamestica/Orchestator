/**
 * Caja para escribir a la mente, al estilo de Claude Code: bandeja de adjuntos arriba, el campo de texto y una barra
 * con «+», la ficha de modo, el esfuerzo de razonamiento y enviar o detener. Se adjunta con el menú «+», soltando
 * archivos sobre la ventana o pegando con Ctrl+V (también fuera del campo). Piezas de studyapp: ver
 * docs/plan/issues/10-modo-chat-ui.md.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Popover } from '@heroui/react';
import { ArrowUp, Paperclip, Plus, Square, Upload, X } from 'lucide-react';
import { nextMindMode } from '../../../shared/api.ts';
import type { Attachment, Effort, MessageDelivery, MindMode } from '../../../shared/api.ts';
import { EffortSlider } from '../../components/EffortSlider.tsx';
import { Kbd } from '../../components/Kbd.tsx';
import { MODE_INFO } from '../chat/format.ts';
import { AttachmentTray } from './AttachmentTray.tsx';
import { growTextarea, hasFiles, isEditable, namePasted, pastedFiles } from './files.ts';
import { useAttachments } from './useAttachments.ts';

/** Cuándo mandar un mensaje mientras la mente trabaja: `later` lo guarda sin enviarlo. */
export type SendTiming = MessageDelivery | 'later';

export interface ComposerProps {
  placeholder: string;
  mode: MindMode;
  onModeChange: (mode: MindMode) => void;
  /** Sube o registra un archivo y devuelve el adjunto. */
  onAttach: (file: File) => Promise<Attachment>;
  /** `delivery` solo viene si se eligió con `askDelivery`; sin él, es un envío normal. */
  onSubmit: (turn: { text: string; attachments: Attachment[]; delivery?: SendTiming }) => boolean | Promise<boolean>;
  isStreaming?: boolean;
  onStop?: () => void;
  /**
   * La mente trabaja: se puede enviar aunque `isStreaming` sea true y, al enviar, el Composer pregunta cuándo
   * entregar el mensaje (ahora, al terminar el turno o más tarde) antes de llamar a `onSubmit`.
   */
  askDelivery?: boolean;
  isDisabled?: boolean;
  /** `false`: la vista dibuja su propia ficha de modo (el atajo Shift+Tab del campo sigue activo). */
  showModeChip?: boolean;
  /** Esfuerzo de razonamiento del próximo mensaje. Sin `onEffortChange` no se muestra la barra de esfuerzo. */
  effort?: Effort;
  onEffortChange?: (effort: Effort) => void;
  /** Niveles que ofrece la barra (por defecto, los de `EffortSlider`). */
  effortLevels?: readonly Effort[];
  /** Texto del campo guardado por quien monta el Composer (p. ej., uno por chat). Sin él, el Composer guarda el suyo. */
  text?: string;
  onTextChange?: (text: string) => void;
  /** Conversación del borrador: al cambiar se vacía la bandeja de adjuntos, salvo si cambia durante un envío. */
  resetKey?: string;
}

const MAX_HEIGHT_PX = 192;

/** Composers montados: solo el último atiende al soltar o pegar fuera de su campo (como en studyapp). */
let claimed = 0;
const claims: number[] = [];

export function Composer({
  placeholder,
  mode,
  onModeChange,
  onAttach,
  onSubmit,
  isStreaming = false,
  onStop,
  askDelivery = false,
  isDisabled = false,
  showModeChip = true,
  effort,
  onEffortChange,
  effortLevels,
  text: controlledText,
  onTextChange,
  resetKey,
}: ComposerProps) {
  const [ownText, setOwnText] = useState('');
  const text = controlledText ?? ownText;
  const setText = onTextChange ?? setOwnText;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const choice = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const composing = useRef(false);
  const pasted = useRef(0);
  const attachments = useAttachments(onAttach);
  const locked = isDisabled || sending;
  const hasContent = text.trim() !== '' || attachments.items.length > 0;
  const canSend = !locked && (!isStreaming || askDelivery) && !attachments.busy
    && !attachments.items.some((item) => item.error)
    && hasContent;

  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const add = useRef(attachments.add);
  add.current = attachments.add;

  useEffect(() => growTextarea(textarea.current, MAX_HEIGHT_PX), [text]);

  // Otra conversación: los adjuntos eran de la anterior. El chat que crea el propio envío no cuenta como otra.
  const clearAttachments = attachments.clear;
  const shownKey = useRef(resetKey);
  useEffect(() => {
    if (shownKey.current === resetKey) return;
    shownKey.current = resetKey;
    if (!submitting.current) clearAttachments();
  }, [resetKey, clearAttachments]);

  // La elección de entrega no tiene sentido si ya no se puede enviar o si la mente quedó libre: se cierra.
  useEffect(() => {
    if (choosing && (!canSend || !askDelivery)) setChoosing(false);
  }, [choosing, canSend, askDelivery]);

  useEffect(() => {
    if (choosing) choice.current?.querySelector('button')?.focus();
  }, [choosing]);

  // Esc detiene el turno; con la elección de entrega abierta, solo la cierra.
  useEffect(() => {
    if (!isStreaming && !choosing) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (choosing) {
        event.preventDefault();
        setChoosing(false);
        textarea.current?.focus();
      } else {
        onStop?.();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [isStreaming, choosing, onStop]);

  // Soltar y pegar en toda la ventana. Soltar siempre se cancela (si no, la ventana navegaría al archivo).
  useEffect(() => {
    const claim = ++claimed;
    claims.push(claim);
    const mine = () => claims.at(-1) === claim;
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      if (!lockedRef.current && mine()) setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => { if (hasFiles(event.dataTransfer)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (lockedRef.current || !mine()) return;
      add.current(Array.from(event.dataTransfer.files));
      textarea.current?.focus();
    };
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      // En otro campo editable (renombrar un chat, ajustes…), Ctrl+V es de ese campo.
      if (event.target !== textarea.current && (isEditable(event.target) || !mine())) return;
      const files = pastedFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      if (lockedRef.current) return;
      add.current(files.map((file) => namePasted(file, ++pasted.current)));
    };
    const reset = () => { depth = 0; setDragging(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    window.addEventListener('blur', reset);
    return () => {
      claims.splice(claims.indexOf(claim), 1);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
      window.removeEventListener('blur', reset);
    };
  }, []);

  const send = async (delivery?: SendTiming) => {
    if (!canSend || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError('');
    try {
      const ready = attachments.items.flatMap((item) => item.attachment ? [item.attachment] : []);
      if (await onSubmit({ text, attachments: ready, ...(delivery ? { delivery } : {}) })) {
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

  /** Enter o el botón: con la mente trabajando pregunta cuándo entregar; si no, envía. */
  const request = () => {
    if (!canSend || submitting.current || choosing) return;
    if (askDelivery) setChoosing(true);
    else void send();
  };

  const choose = (delivery: SendTiming) => {
    setChoosing(false);
    void send(delivery);
  };

  const cancelChoice = () => {
    setChoosing(false);
    textarea.current?.focus();
  };

  const modeInfo = MODE_INFO[mode];
  const alerts = [
    ...attachments.items.flatMap((item) => item.error ? [`No se pudo adjuntar ${item.file.name}. ${item.error}`] : []),
    error,
  ].filter(Boolean);

  return (
    <form
      className={`relative flex flex-col gap-1 rounded-[1.625rem] bg-foreground/[0.06] p-2 transition-shadow duration-quick focus-within:ring-1 focus-within:ring-foreground/20 motion-reduce:transition-none ${dragging ? 'ring-2 ring-foreground/30' : ''}`}
      onSubmit={(event) => { event.preventDefault(); request(); }}
    >
      <AttachmentTray items={attachments.items} onRemove={attachments.remove} isDisabled={locked} />
      {attachments.notice ? (
        <div role="alert" className="flex items-start gap-2 px-3 text-[0.8125rem] text-danger">
          <p className="min-w-0 flex-1">{attachments.notice}</p>
          <button
            type="button"
            aria-label="Cerrar aviso de adjuntos"
            onClick={attachments.dismissNotice}
            className="flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {alerts.length > 0 ? (
        <div role="alert" className="flex flex-col gap-0.5 px-3 text-[0.8125rem] text-danger">
          {alerts.map((line, i) => <p key={`${i}:${line}`}>{line}</p>)}
        </div>
      ) : null}
      <textarea
        ref={textarea}
        value={text}
        rows={1}
        placeholder={dragging ? 'Suelta los archivos para adjuntarlos' : placeholder}
        aria-label="Mensaje"
        disabled={locked}
        className="max-h-48 min-h-10 w-full resize-none overflow-y-auto bg-transparent px-2.5 py-1.5 text-base leading-6 text-foreground placeholder:text-muted focus:outline-none"
        onChange={(event) => setText(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
          if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); onModeChange(nextMindMode(mode)); }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); request(); }
        }}
      />
      {choosing ? (
        <div ref={choice} role="group" aria-label="¿Cuándo lo envío?" className="mx-1 flex flex-wrap items-center gap-1.5 rounded-2xl bg-foreground/[0.06] px-3 py-2">
          <span className="mr-1 text-[0.8125rem] text-muted">¿Cuándo lo envío?</span>
          <Button type="button" size="sm" variant="secondary" onPress={() => choose('now')} className="rounded-full">Ahora</Button>
          <Button type="button" size="sm" variant="secondary" onPress={() => choose('after-turn')} className="rounded-full">Al terminar</Button>
          <Button type="button" size="sm" variant="secondary" onPress={() => choose('later')} className="rounded-full">Más tarde</Button>
          <Button type="button" size="sm" variant="ghost" onPress={cancelChoice} className="rounded-full">Cancelar</Button>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-1">
        <Popover isOpen={menuOpen} onOpenChange={setMenuOpen}>
          <Button type="button" isIconOnly variant="ghost" aria-label="Añadir adjunto" isDisabled={locked} className="size-9 shrink-0 rounded-full"><Plus className="size-5" aria-hidden="true" /></Button>
          <Popover.Content placement="top start" className="w-72">
            <Popover.Dialog aria-label="Adjuntar" className="flex flex-col gap-1 p-1.5">
              <Button type="button" variant="ghost" className="justify-start" onPress={() => { setMenuOpen(false); fileInput.current?.click(); }}>
                <Paperclip aria-hidden="true" className="size-4" />Adjuntar archivo
              </Button>
              <p className="px-2 pb-1 text-[0.75rem] leading-5 text-muted">
                También puedes arrastrar archivos aquí o pegar una imagen con <Kbd>Ctrl+V</Kbd>.
              </p>
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
        {showModeChip ? (
          <Button type="button" variant="ghost" size="sm" isDisabled={locked} aria-label={`Cambiar modo: ${modeInfo.label}`} onPress={() => onModeChange(nextMindMode(mode))} className={`h-8 w-fit shrink-0 rounded-full ${modeInfo.tone}`}>
            {modeInfo.label}<Kbd>Shift+Tab</Kbd>
          </Button>
        ) : null}
        {effort && onEffortChange ? (
          <EffortSlider value={effort} onChange={onEffortChange} {...(effortLevels ? { levels: effortLevels } : {})} isDisabled={isDisabled} />
        ) : null}
        <div className="min-w-0 flex-1" />
        {isStreaming && askDelivery && hasContent ? (
          <Button type="submit" isIconOnly aria-label="Enviar mensaje" isDisabled={!canSend} className="size-9 shrink-0 rounded-full bg-foreground text-canvas">
            <ArrowUp aria-hidden="true" className="size-5" />
          </Button>
        ) : null}
        <Button type={isStreaming ? 'button' : 'submit'} isIconOnly aria-label={isStreaming ? 'Detener respuesta' : 'Enviar mensaje'}
          isDisabled={isStreaming ? !onStop : !canSend} onPress={isStreaming ? onStop : undefined}
          className="size-9 shrink-0 rounded-full bg-foreground text-canvas">
          {isStreaming ? <Square aria-hidden="true" className="size-4" /> : <ArrowUp aria-hidden="true" className="size-5" />}
        </Button>
      </div>
      <input ref={fileInput} type="file" multiple hidden tabIndex={-1} aria-label="Seleccionar archivos" disabled={locked} onChange={(event) => {
        attachments.add(Array.from(event.target.files ?? []));
        event.target.value = '';
      }} />
      {dragging && createPortal(
        <div style={{ position: 'fixed' }} className="drop-overlay pointer-events-none inset-0 z-50 flex flex-col items-center justify-center gap-2" role="status">
          <Upload aria-hidden="true" className="size-12" />
          <p className="text-base font-medium">Suelta para adjuntar</p>
          <p className="text-[0.8125rem] text-muted">Imágenes y archivos de hasta 20 MB</p>
        </div>,
        document.body,
      )}
    </form>
  );
}
