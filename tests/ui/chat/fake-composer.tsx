/**
 * Composer simulado: el de verdad lo hace ui-composer (Codex) en paralelo. Este solo expone sus props
 * para que las pruebas de la vista no dependan de su comportamiento.
 */
import { useState } from 'react';
import type { ComposerProps } from '../../../src/ui/features/composer/Composer.tsx';

export const lastComposerProps: { current: ComposerProps | null } = { current: null };

export function FakeComposer(props: ComposerProps) {
  const [text, setText] = useState('');
  lastComposerProps.current = props;
  return (
    <div data-testid="composer" data-streaming={props.isStreaming ? 'true' : 'false'} data-mode={props.mode}>
      <textarea aria-label="Mensaje" placeholder={props.placeholder} value={text} disabled={props.isDisabled} onChange={(e) => setText(e.target.value)} />
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(props.onSubmit({ text, attachments: [] })).then((ok) => {
            if (ok) setText('');
          });
        }}
      >
        Enviar
      </button>
      {props.isStreaming ? (
        <button type="button" onClick={() => props.onStop?.()}>
          Detener
        </button>
      ) : null}
    </div>
  );
}
