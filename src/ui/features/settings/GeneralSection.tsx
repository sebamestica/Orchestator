import { Input } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/api.ts';
import { useApp } from '../../store/app.ts';
import { Notice, Segmented, SettingsCard, SettingsRow, ToggleField, useSaveSettings } from './shared.tsx';

type Theme = Settings['appearance']['theme'];

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'dark', label: 'Oscuro' },
  { value: 'light', label: 'Claro' },
];

const CONCURRENCY = ['1', '2', '3', '4', '5', '6', '7', '8'].map((v) => ({ value: v, label: v }));

export function GeneralSection() {
  const settings = useApp((s) => s.settings);
  const { save, error, saving } = useSaveSettings();
  const [floor, setFloor] = useState(String(Math.round(settings.quotaFloor * 100)));
  useEffect(() => setFloor(String(Math.round(settings.quotaFloor * 100))), [settings.quotaFloor]);

  const commitFloor = () => {
    const n = Number(floor);
    if (!Number.isFinite(n) || floor.trim() === '') {
      setFloor(String(Math.round(settings.quotaFloor * 100)));
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round(n)));
    setFloor(String(pct));
    if (pct / 100 !== settings.quotaFloor) void save({ quotaFloor: pct / 100 });
  };

  return (
    <div className="flex flex-col gap-8">
      {error ? <Notice>{error}</Notice> : null}
      <SettingsCard title="Apariencia">
        <SettingsRow label="Tema" description="Sistema sigue el tema de Windows.">
          <Segmented label="Tema" value={settings.appearance.theme} options={THEMES} isDisabled={saving} onChange={(theme) => void save({ appearance: { theme } })} />
        </SettingsRow>
        <ToggleField
          label="Menos efectos"
          description="Quita el desenfoque de vidrio y las animaciones largas. Ahorra GPU."
          isSelected={settings.appearance.reducedEffects}
          isDisabled={saving}
          onChange={(reducedEffects) => void save({ appearance: { reducedEffects } })}
        />
      </SettingsCard>
      <SettingsCard title="Flota" description="Cómo reparte el trabajo el orquestador.">
        <SettingsRow label="Concurrencia" description="Agentes trabajando a la vez, sin contar la mente.">
          <Segmented label="Concurrencia" value={String(settings.concurrency)} options={CONCURRENCY} isDisabled={saving} onChange={(v) => void save({ concurrency: Number(v) })} />
        </SettingsRow>
        <SettingsRow label="Umbral de cupo" description="Codex y agy dejan de recibir tareas por debajo de este cupo restante.">
          <span className="flex items-center gap-1.5">
            <Input
              aria-label="Umbral de cupo en porcentaje"
              type="number"
              min={0}
              max={100}
              step={5}
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              onBlur={commitFloor}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitFloor();
              }}
              className="w-20 text-right"
            />
            <span className="text-[0.8125rem] text-muted">%</span>
          </span>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
