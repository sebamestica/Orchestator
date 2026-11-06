import { Button, Chip, Input, Spinner } from '@heroui/react';
import { Check, PackagePlus, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { api } from '../../api/client.ts';
import { errorText, isMissingRoute, Notice, SettingsCard } from './shared.tsx';

/** Lo que muestra la interfaz de `GET /skills` (el núcleo lo manda como `unknown`). */
const skillEntry = z.object({
  name: z.string(),
  folder: z.string().optional(),
  root: z.string().optional(),
  description: z.string().optional(),
  license: z.string().optional(),
  valid: z.boolean().optional(),
  problems: z.array(z.string()).optional(),
});
const skillsResponse = z.object({ skills: z.array(skillEntry) });
type SkillEntry = z.infer<typeof skillEntry>;

/** Informe de cuarentena que devuelven `POST /skills/import` y `GET /skills/quarantine`. */
const quarantined = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  fileCount: z.number().optional(),
  scripts: z.array(z.object({ path: z.string() })).optional(),
  warnings: z.array(z.string()).optional(),
  license: z.object({ declared: z.string().optional(), detected: z.string().optional() }).optional(),
});
const importResponse = z.object({ result: quarantined });
const quarantineResponse = z.object({ skills: z.array(quarantined) });
type Quarantined = z.infer<typeof quarantined>;

const MAX_SHOWN = 200;

export function SkillsSection() {
  const [list, setList] = useState<{ status: 'loading' } | { status: 'ready'; skills: SkillEntry[] } | { status: 'error'; message: string }>({ status: 'loading' });
  const [source, setSource] = useState('');
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [pending, setPending] = useState<Quarantined[]>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = skillsResponse.parse(await api.get<unknown>('/skills'));
      setList({ status: 'ready', skills: r.skills });
    } catch (err) {
      setList({ status: 'error', message: errorText(err) });
    }
  }, []);
  // La cuarentena vive en el disco del núcleo: se vuelve a pedir en vez de recordarla aquí.
  const loadPending = useCallback(async () => {
    try {
      setPending(quarantineResponse.parse(await api.get<unknown>('/skills/quarantine')).skills);
      setPendingError(null);
    } catch (err) {
      // Sin hub (501) ya lo avisa «Instaladas»; no se repite aquí.
      setPendingError(isMissingRoute(err) ? null : errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
    void loadPending();
  }, [load, loadPending]);

  const doImport = async (e: FormEvent) => {
    e.preventDefault();
    const path = source.trim();
    if (!path) return;
    setImporting(true);
    setMessage(null);
    try {
      const r = importResponse.parse(await api.post<unknown>('/skills/import', { source: path }));
      setSource('');
      setMessage({ tone: 'info', text: `«${r.result.name}» quedó en cuarentena. Revísala y apruébala o recházala.` });
      await loadPending();
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err) });
    } finally {
      setImporting(false);
    }
  };

  const decide = async (q: Quarantined, action: 'approve' | 'reject') => {
    setBusy(q.id);
    setMessage(null);
    try {
      await api.post(`/skills/${encodeURIComponent(q.id)}/${action}`);
      setMessage({ tone: 'info', text: action === 'approve' ? `«${q.name}» instalada.` : `«${q.name}» descartada.` });
      await Promise.all([loadPending(), action === 'approve' ? load() : null]);
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <SettingsCard title="Importar" description="Carpeta o .zip local. Entra en cuarentena: nada se ejecuta hasta que la apruebas.">
        <form className="flex items-center gap-2 p-4" onSubmit={(e) => void doImport(e)}>
          <Input aria-label="Ruta de la skill" placeholder="C:\Users\yo\Downloads\mi-skill.zip" value={source} onChange={(e) => setSource(e.target.value)} className="min-w-0 flex-1 font-mono" disabled={importing} />
          <Button type="submit" size="sm" variant="primary" isPending={importing} isDisabled={source.trim() === ''}>
            <PackagePlus className="size-4" aria-hidden="true" />
            Importar
          </Button>
        </form>
      </SettingsCard>

      {pending.length > 0 || pendingError ? (
        <SettingsCard title="En cuarentena">
          {pendingError ? (
            <div className="p-4">
              <Notice>{pendingError}</Notice>
            </div>
          ) : null}
          {pending.map((q) => (
            <div key={q.id} className="flex items-start gap-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.875rem] font-medium text-foreground">{q.name}</div>
                {q.description ? <div className="text-[0.8125rem] text-muted">{q.description}</div> : null}
                <div className="text-[0.75rem] text-muted">
                  {[q.fileCount !== undefined ? `${String(q.fileCount)} archivo(s)` : null, q.license?.declared ?? q.license?.detected ?? 'licencia sin declarar'].filter(Boolean).join(' · ')}
                </div>
                {q.scripts && q.scripts.length > 0 ? <div className="mt-1 text-[0.75rem] text-warning">Ejecutables: {q.scripts.map((s) => s.path).join(', ')}</div> : null}
                {q.warnings?.map((w) => (
                  <div key={w} className="text-[0.75rem] text-warning">
                    {w}
                  </div>
                ))}
              </div>
              <Button size="sm" variant="secondary" isDisabled={busy === q.id} onPress={() => void decide(q, 'reject')}>
                <X className="size-4" aria-hidden="true" />
                Rechazar
              </Button>
              <Button size="sm" variant="primary" isPending={busy === q.id} onPress={() => void decide(q, 'approve')}>
                <Check className="size-4" aria-hidden="true" />
                Aprobar
              </Button>
            </div>
          ))}
        </SettingsCard>
      ) : null}

      <SettingsCard title="Instaladas">
        {list.status === 'loading' ? (
          <span className="flex items-center gap-2 p-4 text-[0.8125rem] text-muted">
            <Spinner size="sm" /> Cargando…
          </span>
        ) : null}
        {list.status === 'error' ? (
          <div className="p-4">
            <Notice>{list.message}</Notice>
          </div>
        ) : null}
        {list.status === 'ready' && list.skills.length === 0 ? (
          <div className="p-4">
            <Notice tone="info">No hay skills instaladas.</Notice>
          </div>
        ) : null}
        {list.status === 'ready'
          ? list.skills.slice(0, MAX_SHOWN).map((s) => (
              <div key={`${s.root ?? ''}/${s.folder ?? s.name}`} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[0.875rem] text-foreground">{s.name}</span>
                    {s.valid === false ? (
                      <Chip size="sm" variant="soft" color="danger">
                        Inválida
                      </Chip>
                    ) : null}
                  </div>
                  {s.description ? <div className="line-clamp-2 text-[0.8125rem] text-muted">{s.description}</div> : null}
                  {s.problems && s.problems.length > 0 ? <div className="text-[0.75rem] text-danger">{s.problems.join(' ')}</div> : null}
                </div>
              </div>
            ))
          : null}
        {list.status === 'ready' && list.skills.length > MAX_SHOWN ? <p className="px-4 py-3 text-[0.75rem] text-muted">Y {String(list.skills.length - MAX_SHOWN)} más.</p> : null}
      </SettingsCard>
    </div>
  );
}
