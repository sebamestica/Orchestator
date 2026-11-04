/** Piezas comunes de los ajustes: tarjetas, interruptores, avisos y guardado de `/settings`. */
import { Label, Switch } from '@heroui/react';
import { AlertTriangle, Info } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { settingsSchema, type SettingsPatch } from '../../../shared/api.ts';
import { api, ApiError } from '../../api/client.ts';
import type { AgentRecord } from '../../api/types.ts';
import { Panel } from '../../components/Card.tsx';
import { useApp } from '../../store/app.ts';

/** La ruta todavía no existe en el núcleo (la hace otra tarea en paralelo). */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

export function errorText(err: unknown): string {
  if (isMissingRoute(err)) return 'El núcleo todavía no tiene esta función. Actualiza el núcleo y vuelve a intentarlo.';
  if (err instanceof Error) return err.message;
  return 'Error desconocido';
}

/** Bloque con título dentro de una sección. */
export function SettingsCard({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <h2 className="text-[0.9375rem] font-medium text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-[0.8125rem] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <Panel className="flex flex-col divide-y divide-foreground/[0.06]">{children}</Panel>
    </section>
  );
}

/** Fila de una tarjeta: texto a la izquierda y control a la derecha. */
export function SettingsRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[0.875rem] text-foreground">{label}</span>
        {description ? <span className="text-[0.8125rem] text-muted">{description}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Interruptor con etiqueta y descripción (como ToggleField de studyapp). */
export function ToggleField({ label, description, isSelected, isDisabled, onChange }: { label: string; description?: string; isSelected: boolean; isDisabled?: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="px-4 py-3.5">
      <Switch isSelected={isSelected} isDisabled={isDisabled ?? false} onChange={onChange}>
        <Switch.Content className="w-full justify-between gap-6">
          <span className="flex min-w-0 flex-col gap-0.5">
            <Label className="text-[0.875rem] text-foreground">{label}</Label>
            {description ? <span className="text-[0.8125rem] text-muted">{description}</span> : null}
          </span>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
}

/** Aviso en línea (error o información). */
export function Notice({ tone = 'error', children }: { tone?: 'error' | 'info'; children: ReactNode }) {
  const Icon = tone === 'error' ? AlertTriangle : Info;
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-[0.8125rem] ${tone === 'error' ? 'bg-danger/10 text-danger' : 'bg-foreground/[0.045] text-muted'}`}>
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Grupo de opciones excluyentes en píldoras (tema, esfuerzo, proveedor…). */
export function Segmented<T extends string>({ label, value, options, onChange, isDisabled }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; isDisabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1 rounded-xl bg-foreground/[0.045] p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={isDisabled}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
            className={`h-7 rounded-lg px-2.5 text-[0.8125rem] transition-colors duration-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50 ${on ? 'bg-foreground text-canvas' : 'text-muted hover:bg-foreground/[0.08] hover:text-foreground'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Guarda un cambio parcial de ajustes y deja en el store la respuesta del núcleo. */
export function useSaveSettings() {
  const setSettings = useApp((s) => s.setSettings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const res = await api.patch<{ settings: unknown }>('/settings', patch);
        setSettings(settingsSchema.parse(res.settings));
        return true;
      } catch (err) {
        setError(errorText(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [setSettings],
  );
  return { save, error, saving };
}

/** Deja en el store un agente devuelto por la API (igual que si llegara por `/ws`). */
export function putAgent(agent: AgentRecord): void {
  useApp.getState().applyLive({ type: 'agent', agent });
}

export function dropAgent(agentId: string): void {
  useApp.getState().applyLive({ type: 'agent_deleted', agentId });
}

export const KIND_LABEL: Record<string, string> = {
  'claude-sdk': 'Claude (SDK)',
  'codex-cli': 'Codex CLI',
  'agy-cli': 'Antigravity CLI',
  api: 'API',
};
