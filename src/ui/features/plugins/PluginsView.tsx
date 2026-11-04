import { useEffect, useState } from 'react';
import { Button, Chip, Label, ListBox, Select, Spinner } from '@heroui/react';
import { Globe, Palette } from 'lucide-react';
import { z } from 'zod';
import { pluginSchema, type Plugin, type ConnectPluginBody } from '../../../shared/api.ts';
import { api, ApiError } from '../../api/client.ts';
import { getLive } from '../../api/live.ts';
import { Panel } from '../../components/Card.tsx';
import { PageBody, PageHeader } from '../../components/PageBody.tsx';

const statuses = { disconnected: 'Desconectado', connecting: 'Conectando', connected: 'Conectado', error: 'Error' };
function merge(items: Plugin[], next: Plugin): Plugin[] {
  if (items.some((p) => p.id === next.id && p.updatedAt > next.updatedAt)) return items;
  return [...items.filter((p) => p.id !== next.id), next].sort((a, b) => a.id.localeCompare(b.id));
}
export default function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [profile, setProfile] = useState<'personal' | 'agente'>('personal');
  const [busy, setBusy] = useState<Partial<Record<Plugin['id'], boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let frame: number | undefined;
    const pending = new Map<Plugin['id'], Plugin>();
    const unsubscribe = getLive()?.subscribe((message) => {
      if (message.type !== 'plugin') return;
      const parsed = pluginSchema.safeParse(message.plugin);
      if (!parsed.success) return;
      const previous = pending.get(parsed.data.id);
      if (!previous || previous.updatedAt <= parsed.data.updatedAt) pending.set(parsed.data.id, parsed.data);
      frame ??= requestAnimationFrame(() => {
        setPlugins((current) => [...pending.values()].reduce(merge, current));
        pending.clear(); frame = undefined;
      });
    });
    void api.get<unknown>('/plugins').then((data) => {
      const result = z.object({ plugins: z.array(pluginSchema) }).parse(data);
      if (active) setPlugins((current) => current.reduce(merge, result.plugins.reduce(merge, [])));
    }).catch((e: unknown) => { if (active) setError(pluginError(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe?.(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);
  async function change(plugin: Plugin, disconnect: boolean) {
    setBusy((b) => ({ ...b, [plugin.id]: true })); setError('');
    try {
      const body: ConnectPluginBody = plugin.id === 'chrome' ? { profile } : {};
      const result = z.object({ plugin: pluginSchema, authUrl: z.url().optional() }).parse(await api.post<unknown>(`/plugins/${plugin.id}/${disconnect ? 'disconnect' : 'connect'}`, disconnect ? {} : body));
      setPlugins((current) => merge(current, result.plugin));
      const authUrl = result.authUrl ?? result.plugin.authUrl;
      if (!disconnect && authUrl) {
        const url = new URL(authUrl);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('El enlace de conexión no es válido.');
        if (window.orq) await window.orq.openExternal(url.href);
        else window.open(url.href, '_blank', 'noopener,noreferrer');
      }
    } catch (e) { setError(pluginError(e)); }
    finally { setBusy((b) => ({ ...b, [plugin.id]: false })); }
  }
  return <PageBody><PageHeader title="Plugins" description="Conecta tus cuentas para que los agentes trabajen con ellas" />
    {error && <p role="alert" className="mb-4 text-sm text-muted">{error}</p>}{loading && <Spinner aria-label="Cargando plugins" />}
    <div className="space-y-4">{plugins.map((plugin) => {
      const Icon = plugin.id === 'chrome' ? Globe : Palette;
      const disconnect = plugin.status === 'connected' || plugin.status === 'connecting';
      return <Panel key={plugin.id} className="space-y-4 p-5">
        <div className="flex items-center gap-3"><Icon aria-hidden="true" size={24} /><h2 className="flex-1 font-medium">{plugin.name}</h2><Chip>{statuses[plugin.status]}</Chip></div>
        <p className="text-sm text-muted">{plugin.description}</p>{plugin.detail && <p className="text-sm" role="status">{plugin.detail}</p>}
        {plugin.steps.length > 0 && <ol className="list-inside list-decimal text-sm text-muted">{plugin.steps.slice(0, 500).map((step, i) => <li key={i}>{step}</li>)}</ol>}
        {plugin.id === 'chrome' && <Select aria-label="Perfil de Chrome" value={profile} isDisabled={!!busy.chrome || disconnect} onChange={(value) => { if (value === 'personal' || value === 'agente') setProfile(value); }}>
          <Label>Perfil de Chrome</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox><ListBox.Item id="personal" textValue="Mi Chrome, con mis sesiones">Mi Chrome, con mis sesiones</ListBox.Item><ListBox.Item id="agente" textValue="Perfil propio de los agentes">Perfil propio de los agentes</ListBox.Item></ListBox></Select.Popover>
        </Select>}
        <Button className="bg-foreground text-canvas" isDisabled={!!busy[plugin.id]} onPress={() => { void change(plugin, disconnect); }} aria-label={`${disconnect ? 'Desconectar' : 'Conectar'} ${plugin.name}`}>{disconnect ? 'Desconectar' : 'Conectar'}</Button>
      </Panel>;
    })}<Panel className="p-5 text-sm text-muted">Más plugins pronto</Panel></div>
  </PageBody>;
}
function pluginError(error: unknown): string {
  if (error instanceof ApiError && [404, 501].includes(error.status)) return 'Los plugins todavía no están disponibles en este núcleo.';
  return error instanceof Error ? error.message : 'No se pudo actualizar el plugin.';
}
