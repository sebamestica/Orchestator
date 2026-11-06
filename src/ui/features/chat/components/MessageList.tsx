import { Check, Copy } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import type { AgentEvent, ChatMessage } from '../../../../shared/index.ts';
import { activityOf, buildReply } from '../timeline.ts';
import { AttachmentList } from './AttachmentThumb.tsx';
import { ActivitySummary, ItemRow } from './LiveReply.tsx';
import { Markdown, useCopy } from './Markdown.tsx';

function CopyMessage({ text }: { text: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copiado' : 'Copiar respuesta'}
      title={copied ? 'Copiado' : 'Copiar respuesta'}
      onClick={copy}
      className="reveal flex size-7 items-center justify-center rounded-lg text-muted transition-colors duration-quick hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

export const UserMessage = memo(function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex flex-col items-end gap-2" data-testid="user-message">
      <AttachmentList attachments={message.attachments} />
      {message.text ? (
        <div className="selectable max-w-[78%] whitespace-pre-wrap break-words rounded-2xl bg-foreground/[0.06] px-4 py-2.5 text-[0.9375rem] leading-relaxed text-foreground">
          {message.text}
        </div>
      ) : null}
    </div>
  );
});

export function AssistantMessage({ message, events }: { message: ChatMessage; events?: readonly AgentEvent[] }) {
  const steps = useMemo(() => (events ? activityOf(buildReply(events)) : []), [events]);
  return (
    <div className="group flex flex-col gap-2" data-testid="assistant-message">
      {steps.length ? <ActivitySummary items={steps} /> : null}
      <AttachmentList attachments={message.attachments} align="start" />
      <Markdown text={message.text} />
      {message.text ? (
        <div className="flex items-center gap-1">
          <CopyMessage text={message.text} />
        </div>
      ) : null}
    </div>
  );
}

/** Turno que terminó sin respuesta guardada: sus errores a la vista y el resto de sus pasos plegados. */
function OrphanTurn({ events }: { events: readonly AgentEvent[] }) {
  const steps = useMemo(() => activityOf(buildReply(events)), [events]);
  const errors = steps.filter((i) => i.kind === 'error');
  return (
    <div className="flex flex-col" data-testid="orphan-turn">
      <p className="px-2 text-[0.8125rem] text-muted">Este turno terminó sin respuesta</p>
      {errors.length ? (
        <ul className="flex flex-col">
          {errors.map((item) => (
            <ItemRow key={item.key} item={item} running={false} announce={false} />
          ))}
        </ul>
      ) : null}
      <ActivitySummary items={steps.filter((i) => i.kind !== 'error')} />
    </div>
  );
}

/** Hilo: mensajes guardados con lo que se ancla tras cada uno (propuestas, turnos sin respuesta) y, al final, lo que está en curso. */
export function MessageList({
  messages,
  eventsByMessage,
  orphans,
  after,
  tail,
}: {
  messages: readonly ChatMessage[];
  eventsByMessage: ReadonlyMap<string, AgentEvent[]>;
  /** Eventos de un turno sin respuesta guardada, por el mensaje tras el que van. */
  orphans: ReadonlyMap<string, AgentEvent[]>;
  /** Contenido que va después de un mensaje (p. ej. la tarjeta de propuestas). */
  after: (messageId: string) => ReactNode;
  tail: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      {messages.map((m) => {
        const extra = after(m.id);
        const ev = eventsByMessage.get(m.id);
        const orphan = orphans.get(m.id);
        return (
          <div key={m.id} className="flex flex-col gap-4">
            {m.role === 'user' ? <UserMessage message={m} /> : <AssistantMessage message={m} {...(ev ? { events: ev } : {})} />}
            {extra}
            {orphan ? <OrphanTurn events={orphan} /> : null}
          </div>
        );
      })}
      {tail}
    </div>
  );
}
