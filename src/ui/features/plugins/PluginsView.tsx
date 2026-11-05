import { useEffect, useState } from 'react';
import { Button, Chip, Spinner } from '@heroui/react';
import { Globe, Palette } from 'lucide-react';
import { z } from 'zod';
import { pluginSchema, type Plugin } from '../../../shared/api.ts';
import { api, ApiError } from '../../api/client.ts';
import { getLive } from '../../api/live.ts';
import { Panel } from '../../components/Card.tsx';
import { PageBody, PageHeader } from '../../components/PageBody.tsx';

const statuses = { disconnected: 'Desconectado', connecting: 'Conectando', connected: 'Conectado', error: 'Error' };
/** Cada cuánto se relee el estado vivo de Chrome (quién lo usa, depuración remota) mientras la vista está abierta. */
export const LIVE_REFRESH_MS = 15_000;
const listSchema = z.object({ plugins: z.array(pluginSchema) });

function merge(items: Plugin[], next: Plugin): Plugin[] {
  if (items.some((p) => p.id === next.id && p.updatedAt > next.updatedAt)) return items;
  return [...items.filter((p) => p.id !== next.id), next].sort((a, b) => a.id.localeCompare(b.id));
}
export default function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
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
        // Copia antes de vaciar: React puede llamar al actualizador más tarde, ya con `pending` vacío.
        const batch = [...pending.values()];
        pending.clear(); frame = undefined;
        setPlugins((current) => batch.reduce(merge, current));
      });
    });
    const load = async () => listSchema.parse(await api.get<unknown>('/plugins')).plugins;
    // Primera lectura: lo que ya llegó por /ws con la misma fecha manda.
    void load().then((list) => { if (active) setPlugins((current) => current.reduce(merge, list.reduce(merge, []))); })
      .catch((e: unknown) => { if (active) setError(pluginError(e)); }).finally(() => { if (active) setLoading(false); });
    // El estado vivo de Chrome (quién lo usa ahora) no llega por /ws: se relee de vez en cuando y gana a lo que había.
    const timer = window.setInterval(() => {
      void load().then((list) => { if (active) setPlugins((current) => list.reduce(merge, current)); }).catch(() => undefined);
    }, LIVE_REFRESH_MS);
    return () => { active = false; unsubscribe?.(); window.clearInterval(timer); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);
  async function change(plugin: Plugin, disconnect: boolean) {
    setBusy((b) => ({ ...b, [plugin.id]: true })); setError('');
    try {
      const result = z.object({ plugin: pluginSchema, authUrl: z.url().optional() }).parse(await api.post<unknown>(`/plugins/${plugin.id}/${disconnect ? 'disconnect' : 'connect'}`, {}));
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
      const chrome = plugin.id === 'chrome';
      const Icon = chrome ? Globe : Palette;
      const active = plugin.status === 'connected' || plugin.status === 'connecting';
      return <Panel key={plugin.id} className="space-y-4 p-5">
        <div className="flex items-center gap-3"><Icon aria-hidden="true" size={24} /><h2 className="flex-1 font-medium">{plugin.name}</h2><Chip>{statuses[plugin.status]}</Chip></div>
        <p className="text-sm text-muted">{plugin.description}</p>
        {plugin.detail && (chrome
          // Chrome: el núcleo junta el estado vivo con « · » (conexión, depuración remota, perfil, quién lo usa ahora).
          ? <ul className="space-y-1 text-sm" role="status" aria-label="Estado de tu Chrome">{chromeLines(plugin.detail).map((line, i) => <li key={i}>{line}</li>)}</ul>
          : <p className="text-sm" role="status">{plugin.detail}</p>)}
        {plugin.steps.length > 0 && <ol className="list-inside list-decimal text-sm text-muted">{plugin.steps.slice(0, 500).map((step, i) => <li key={i}>{step}</li>)}</ol>}
        <div className="flex flex-wrap gap-2">{chrome
          ? <>
            <Button className="bg-foreground text-canvas" isDisabled={!!busy.chrome} onPress={() => { void change(plugin, false); }} aria-label="Probar conexión de Chrome">Probar conexión</Button>
            {active && <Button variant="secondary" isDisabled={!!busy.chrome} onPress={() => { void change(plugin, true); }} aria-label="Desconectar Chrome">Desconectar</Button>}
          </>
          : <Button className="bg-foreground text-canvas" isDisabled={!!busy[plugin.id]} onPress={() => { void change(plugin, active); }} aria-label={`${active ? 'Desconectar' : 'Conectar'} ${plugin.name}`}>{active ? 'Desconectar' : 'Conectar'}</Button>}
        </div>
      </Panel>;
    })}<Panel className="p-5 text-sm text-muted">Más plugins pronto</Panel></div>
  </PageBody>;
}
/** «Tu Chrome personal · 32 herramientas · …» → una línea por dato (las dos primeras juntas). */
export function chromeLines(detail: string): string[] {
  const parts = detail.split(' · ').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^\d+ herramientas?$/.test(parts[1] ?? '')) parts.splice(0, 2, `${parts[0]} · ${parts[1]}`);
  return parts;
}
function pluginError(error: unknown): string {
  if (error instanceof ApiError && [404, 501].includes(error.status)) return 'Los plugins todavía no están disponibles en este núcleo.';
  return error instanceof Error ? error.message : 'No se pudo actualizar el plugin.';
}
