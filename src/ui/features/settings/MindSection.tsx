import { Chip, ListBox, ListBoxItem, Select, Spinner } from '@heroui/react';
import { Check, Brain } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { effortSchema, mindCandidateSchema, mindModeSchema, type Effort, type MindCandidate } from '../../../shared/api.ts';
import { api } from '../../api/client.ts';
import { useApp } from '../../store/app.ts';
import { MODE_INFO } from '../chat/format.ts';
import { errorText, isMissingRoute, KIND_LABEL, Notice, Segmented, SettingsCard, SettingsRow, ToggleField, useSaveSettings } from './shared.tsx';

const candidatesResponse = z.object({ candidates: z.array(mindCandidateSchema) });

const EFFORT_LABEL: Record<Effort, string> = { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };
const EFFORTS = effortSchema.options.map((value) => ({ value, label: EFFORT_LABEL[value] }));

/** Clave del Select para «sin modelo fijo» (usa el del agente). */
const AGENT_MODEL = '__agente__';

const SUPPORT_LABEL = { full: 'Completa', experimental: 'Experimental', none: 'No disponible' } as const;

type Load = { state: 'loading' } | { state: 'ready'; candidates: MindCandidate[] } | { state: 'error'; message: string };

export function MindSection() {
  const settings = useApp((s) => s.settings);
  const agents = useApp((s) => s.agents);
  const { save, error, saving } = useSaveSettings();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let alive = true;
    api.get<unknown>('/mind/candidates').then(
      (r) => {
        if (!alive) return;
        const parsed = candidatesResponse.safeParse(r);
        setLoad(parsed.success ? { state: 'ready', candidates: parsed.data.candidates } : { state: 'error', message: 'El núcleo devolvió una lista de candidatos con un formato inesperado.' });
      },
      (err: unknown) => {
        if (alive) setLoad({ state: 'error', message: isMissingRoute(err) ? 'El núcleo aún no lista candidatos a mente (GET /mind/candidates). Actualiza el núcleo.' : errorText(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const candidates = load.state === 'ready' ? load.candidates : [];
  // `agentId: null` = el primer agente con soporte completo.
  const effectiveId = settings.mind.agentId ?? candidates.find((c) => c.support === 'full')?.agentId ?? null;
  const current = candidates.find((c) => c.agentId === effectiveId);
  const models = useMemo(() => {
    const list = [...(current?.models ?? [])];
    if (settings.mind.model && !list.includes(settings.mind.model)) list.unshift(settings.mind.model);
    return list;
  }, [current, settings.mind.model]);

  const enabled = useMemo(() => agents.filter((a) => a.config.enabled).sort((a, b) => a.config.displayName.localeCompare(b.config.displayName)), [agents]);
  const isWorker = (id: string) => settings.workers.length === 0 || settings.workers.includes(id);
  const activeCount = enabled.filter((a) => isWorker(a.config.id)).length;

  const toggleWorker = (id: string, on: boolean) => {
    const next = enabled.map((a) => a.config.id).filter((x) => (x === id ? on : isWorker(x)));
    if (next.length === 0) return;
    void save({ workers: next.length === enabled.length ? [] : next });
  };

  return (
    <div className="flex flex-col gap-8">
      {error ? <Notice>{error}</Notice> : null}

      <SettingsCard title="Mente" description="El agente que conversa contigo, planifica y reparte el trabajo a la flota.">
        <div className="flex flex-col gap-4 p-4">
          {load.state === 'loading' ? (
            <span className="flex items-center gap-2 text-[0.8125rem] text-muted">
              <Spinner size="sm" /> Cargando candidatos…
            </span>
          ) : null}
          {load.state === 'error' ? <Notice>{load.message}</Notice> : null}
          {load.state === 'ready' && candidates.length === 0 ? <Notice tone="info">No hay agentes que puedan ser mente. Agrega uno de Claude en «Agentes».</Notice> : null}
          {candidates.length > 0 ? (
            <div role="radiogroup" aria-label="Mente" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {candidates.map((c) => (
                <MindCard
                  key={c.agentId}
                  candidate={c}
                  selected={c.agentId === effectiveId}
                  isDefault={settings.mind.agentId === null && c.agentId === effectiveId}
                  disabled={saving || c.support === 'none'}
                  onSelect={() => void save({ mind: { agentId: c.agentId, model: null } })}
                />
              ))}
            </div>
          ) : null}
        </div>
        {current ? (
          <SettingsRow label="Modelo" description="Sin fijar, usa el modelo configurado en el agente.">
            <Select
              aria-label="Modelo de la mente"
              className="w-56"
              selectedKey={settings.mind.model ?? AGENT_MODEL}
              isDisabled={saving}
              onSelectionChange={(key) => {
                if (key === null) return;
                const model = String(key);
                const next = model === AGENT_MODEL ? null : model;
                if (next !== (settings.mind.model ?? null)) void save({ mind: { model: next } });
              }}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox className="max-h-64 overflow-y-auto p-1.5">
                  <ListBoxItem key={AGENT_MODEL} id={AGENT_MODEL} textValue="Del agente">
                    Del agente
                  </ListBoxItem>
                  {models.map((m) => (
                    <ListBoxItem key={m} id={m} textValue={m}>
                      {m}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </SettingsRow>
        ) : null}
        <SettingsRow label="Esfuerzo" description="Más esfuerzo piensa más y gasta más.">
          <Segmented label="Esfuerzo" value={settings.mind.effort} options={EFFORTS} isDisabled={saving} onChange={(effort) => void save({ mind: { effort } })} />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Subagentes" description="Agentes a los que la mente puede delegar tareas. Si todos están activos, también se usarán los que agregues después.">
        {enabled.length === 0 ? (
          <div className="p-4">
            <Notice tone="info">No hay agentes habilitados. Agrégalos o habilítalos en «Agentes».</Notice>
          </div>
        ) : (
          enabled.map((a) => {
            const on = isWorker(a.config.id);
            return (
              <ToggleField
                key={a.config.id}
                label={a.config.displayName}
                description={[KIND_LABEL[a.config.kind] ?? a.config.kind, a.config.model, a.config.id === effectiveId ? 'es la mente' : null].filter(Boolean).join(' · ')}
                isSelected={on}
                isDisabled={saving || (on && activeCount <= 1)}
                onChange={(value) => toggleWorker(a.config.id, value)}
              />
            );
          })
        )}
      </SettingsCard>

      <SettingsCard title="Modo inicial de los chats" description="Shift+Tab lo cambia dentro del chat. Push, despliegue, pagos y borrar ramas siguen bloqueados en todos los modos.">
        <div role="radiogroup" aria-label="Modo inicial" className="flex flex-col gap-2 p-3">
          {mindModeSchema.options.map((mode) => {
            const on = settings.defaultMode === mode;
            const m = MODE_INFO[mode];
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={saving}
                onClick={() => {
                  if (!on) void save({ defaultMode: mode });
                }}
                className={`flex items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${on ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.045]'}`}
              >
                <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${on ? 'border-foreground bg-foreground text-canvas' : 'border-foreground/20'}`}>
                  {on ? <Check className="size-3" aria-hidden="true" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.875rem] font-medium text-foreground">{m.label}</span>
                  <span className="block text-[0.8125rem] text-muted">{m.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingsCard>
    </div>
  );
}

function MindCard({ candidate, selected, isDefault, disabled, onSelect }: { candidate: MindCandidate; selected: boolean; isDefault: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={candidate.displayName}
      disabled={disabled}
      onClick={() => {
        if (!selected) onSelect();
      }}
      className={`group/card relative flex flex-col gap-2 rounded-2xl bg-foreground/[0.045] p-4 text-left transition-[background-color,box-shadow] duration-quick hover:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-foreground/[0.045] ${selected ? 'ring-2 ring-foreground ring-offset-2 ring-offset-canvas' : ''}`}
    >
      <span className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-muted">
          <Brain className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.9375rem] font-medium text-foreground">{candidate.displayName}</span>
          <span className="block truncate text-[0.75rem] text-muted">{KIND_LABEL[candidate.kind] ?? candidate.kind}{isDefault ? ' · predeterminada' : ''}</span>
        </span>
        <span aria-hidden="true" className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-foreground bg-foreground text-canvas' : 'border-foreground/10 text-transparent'}`}>
          <Check className="size-3.5" />
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip size="sm" color={candidate.support === 'full' ? 'success' : candidate.support === 'experimental' ? 'warning' : 'default'} variant="soft">
          {SUPPORT_LABEL[candidate.support]}
        </Chip>
      </span>
      {candidate.note ? <span className="text-[0.75rem] text-muted">{candidate.note}</span> : null}
    </button>
  );
}
