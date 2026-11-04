import { ListBox, ListBoxItem, Select, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from '../../api/client.ts';
import { useApp } from '../../store/app.ts';
import { errorText, Notice, SettingsCard, SettingsRow } from './shared.tsx';

const contextResponse = z.object({ projectId: z.string(), budgetChars: z.number(), chars: z.number(), context: z.string() });
type Context = z.infer<typeof contextResponse>;

/** Recorte de lo que se pinta: el contexto puede ser largo y el PC es modesto. */
const MAX_SHOWN = 60_000;

export function MemorySection() {
  const projects = useApp((s) => s.projects);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [state, setState] = useState<{ status: 'idle' | 'loading' } | { status: 'ready'; data: Context } | { status: 'error'; message: string }>({ status: 'idle' });
  const selected = projectId ?? projects[0]?.id ?? null;

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setState({ status: 'loading' });
    api.get<unknown>(`/memory/${encodeURIComponent(selected)}/context`).then(
      (r) => {
        if (!alive) return;
        const parsed = contextResponse.safeParse(r);
        setState(parsed.success ? { status: 'ready', data: parsed.data } : { status: 'error', message: 'El núcleo devolvió el contexto de memoria con un formato inesperado.' });
      },
      (err: unknown) => {
        if (alive) setState({ status: 'error', message: errorText(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [selected]);

  if (projects.length === 0) return <Notice tone="info">Agrega un proyecto para ver su memoria.</Notice>;

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard title="Memoria" description="Lo que la flota lee de Obsidian sobre el proyecto antes de cada tarea.">
        <SettingsRow label="Proyecto">
          <Select aria-label="Proyecto" className="w-56" selectedKey={selected} onSelectionChange={(k) => k !== null && setProjectId(String(k))}>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox className="max-h-64 overflow-y-auto p-1.5">
                {projects.map((p) => (
                  <ListBoxItem key={p.id} id={p.id} textValue={p.name}>
                    {p.name}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </SettingsRow>
        <div className="flex flex-col gap-2 p-4">
          {state.status === 'loading' ? (
            <span className="flex items-center gap-2 text-[0.8125rem] text-muted">
              <Spinner size="sm" /> Cargando…
            </span>
          ) : null}
          {state.status === 'error' ? <Notice>{state.message}</Notice> : null}
          {state.status === 'ready' ? (
            <>
              <span className="text-[0.75rem] text-muted">
                {state.data.chars.toLocaleString('es')} de {state.data.budgetChars.toLocaleString('es')} caracteres
              </span>
              {state.data.context ? (
                <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-xl bg-foreground/[0.045] p-3 font-mono text-[0.75rem] text-foreground">
                  {state.data.context.length > MAX_SHOWN ? `${state.data.context.slice(0, MAX_SHOWN)}\n…` : state.data.context}
                </pre>
              ) : (
                <Notice tone="info">El proyecto aún no tiene memoria.</Notice>
              )}
            </>
          ) : null}
        </div>
      </SettingsCard>
    </div>
  );
}
