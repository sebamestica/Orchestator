/** Alta de un agente con clave de API. La clave no pasa por el estado de React: se lee del campo al enviar y se borra. */
import { Button, Input, Label, Modal, TextField } from '@heroui/react';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../../api/client.ts';
import type { AgentRecord, ProbeResponse } from '../../api/types.ts';
import { addAgentResponse, InvalidResponseError, parseResponse } from './schemas.ts';
import { errorText, Notice, putAgent, Segmented } from './shared.tsx';

export type KeyProvider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'openai-compatible';

const PROVIDERS: readonly { value: KeyProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai-compatible', label: 'Compatible con OpenAI' },
];

const DEFAULT_NAME: Record<KeyProvider, string> = {
  anthropic: 'Claude (mi clave)',
  openai: 'OpenAI (mi clave)',
  google: 'Gemini (mi clave)',
  openrouter: 'OpenRouter',
  'openai-compatible': 'Servidor compatible',
};

interface AddAgentDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onAdded: (agent: AgentRecord, probe: ProbeResponse['probe'] | null) => void;
}

export function AddAgentDialog({ isOpen, onOpenChange, onAdded }: AddAgentDialogProps) {
  const [provider, setProvider] = useState<KeyProvider>('anthropic');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  const url = baseUrl.trim();
  const insecure = /^http:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
  const needsUrl = provider === 'openai-compatible';

  const close = (open: boolean) => {
    if (!open && keyRef.current) keyRef.current.value = '';
    if (!open) setError(null);
    onOpenChange(open);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = keyRef.current;
    const apiKey = input?.value.trim() ?? '';
    // La clave sale del campo ahora mismo: no queda en el DOM ni en el estado mientras se prueba.
    if (input) input.value = '';
    if (apiKey.length < 8) {
      setError('Escribe la clave de API (al menos 8 caracteres).');
      return;
    }
    if (needsUrl && !url) {
      setError('La URL base es obligatoria para un servidor compatible con OpenAI.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const raw = await api.post<unknown>('/agents', {
        provider,
        apiKey,
        displayName: name.trim() || DEFAULT_NAME[provider],
        ...(url ? { baseUrl: url } : {}),
      });
      const res = parseResponse(addAgentResponse, raw, 'el agente nuevo');
      putAgent(res.agent);
      onAdded(res.agent, res.probe);
      setName('');
      setBaseUrl('');
      onOpenChange(false);
    } catch (err) {
      // Si la respuesta es inválida el núcleo pudo haber guardado el agente: no invitar a repetir el alta a ciegas.
      setError(err instanceof InvalidResponseError ? `${errorText(err)} Revisa la lista de agentes antes de reintentar.` : `${errorText(err)} Vuelve a escribir la clave para reintentar.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={close}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Agregar agente por clave</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
              <div className="flex flex-col gap-1.5">
                <span className="text-[0.8125rem] text-muted">Proveedor</span>
                <Segmented label="Proveedor" value={provider} options={PROVIDERS} isDisabled={pending} onChange={setProvider} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="orq-agent-key" className="text-[0.8125rem] text-muted">
                  Clave de API
                </label>
                <Input id="orq-agent-key" ref={keyRef} type="password" autoComplete="off" spellCheck={false} placeholder="Se guarda cifrada en Windows (DPAPI)" disabled={pending} />
              </div>
              <TextField value={baseUrl} onChange={setBaseUrl} isDisabled={pending} fullWidth>
                <Label>{needsUrl ? 'URL base' : 'URL base (opcional)'}</Label>
                <Input placeholder="https://…" autoComplete="off" />
              </TextField>
              {insecure ? <Notice>La URL usa http:// sin cifrar: la clave viajaría en claro. Usa https://.</Notice> : null}
              <TextField value={name} onChange={setName} isDisabled={pending} fullWidth>
                <Label>Nombre</Label>
                <Input placeholder={DEFAULT_NAME[provider]} autoComplete="off" />
              </TextField>
              {error ? <Notice>{error}</Notice> : null}
              <p className="text-[0.75rem] text-muted">El núcleo prueba la clave antes de guardarla; si la prueba falla no se guarda nada.</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onPress={() => close(false)}>
                  Cancelar
                </Button>
                <Button type="submit" variant="primary" isPending={pending}>
                  Agregar
                </Button>
              </div>
            </form>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
