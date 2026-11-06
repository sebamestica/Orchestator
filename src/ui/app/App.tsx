import { Plug } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { resolveCore } from '../api/bridge.ts';
import { setCoreEndpoint } from '../api/client.ts';
import { startLive } from '../api/live.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { AgentsPanel } from '../features/agents-panel/AgentsPanel.tsx';
import { HomeView } from '../features/home/HomeView.tsx';
import { useApp } from '../store/app.ts';
import { Sidebar } from './Sidebar.tsx';
import { TitleBar } from './TitleBar.tsx';
import type { Route } from './routes.ts';
import { useAgentsPanel } from './use-agents-panel.ts';
import { useRoute } from './use-route.ts';
import { BootScreen } from '../components/BootScreen.tsx';

// Vistas pesadas por demanda: la portada carga sola y rápido.
const ChatView = lazy(() => import('../features/chat/ChatView.tsx'));
const BoardView = lazy(() => import('../features/board/BoardView.tsx'));
const SettingsView = lazy(() => import('../features/settings/SettingsView.tsx'));
const PluginsView = lazy(() => import('../features/plugins/PluginsView.tsx'));

function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomeView />;
    case 'project':
      return <ChatView key={`p:${route.projectId}`} projectId={route.projectId} {...(route.chatId ? { chatId: route.chatId } : {})} />;
    case 'standalone':
      return <ChatView key="suelto" projectId={null} {...(route.chatId ? { chatId: route.chatId } : {})} />;
    case 'board':
      return <BoardView {...(route.projectId ? { projectId: route.projectId } : {})} />;
    case 'settings':
      return <SettingsView section={route.section} />;
    case 'plugins':
      return <PluginsView />;
  }
}

function useBootstrap() {
  const setCore = useApp((s) => s.setCore);
  const setLive = useApp((s) => s.setLive);
  const loadAll = useApp((s) => s.loadAll);
  const applyLive = useApp((s) => s.applyLive);
  useEffect(() => {
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const core = await resolveCore();
        if (!core) {
          setCore('missing');
          return;
        }
        setCoreEndpoint(core);
        await loadAll();
        setCore('ready');
        const live = startLive(core);
        const offStatus = live.onStatus(setLive);
        const offMsg = live.subscribe(applyLive);
        stop = () => {
          offStatus();
          offMsg();
          live.stop();
        };
      } catch (err) {
        setCore('error', err instanceof Error ? err.message : String(err));
      }
    })();
    return () => stop?.();
  }, [setCore, setLive, loadAll, applyLive]);
}

function useShortcuts() {
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);
}

function useAppearance() {
  const appearance = useApp((s) => s.settings.appearance);
  useEffect(() => {
    const root = document.documentElement;
    const dark = appearance.theme === 'dark' || (appearance.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.effects = appearance.reducedEffects ? 'reduced' : 'full';
  }, [appearance]);
}

export function App() {
  useBootstrap();
  useShortcuts();
  useAppearance();
  const route = useRoute();
  const core = useApp((s) => s.core);
  const coreError = useApp((s) => s.coreError);
  const panel = useAgentsPanel(route);

  return (
    <div className="flex h-full flex-col bg-canvas text-foreground">
      <TitleBar route={route} />
      <div className="flex min-h-0 flex-1">
        <Sidebar route={route} />
        <div className="chrome-frame relative flex min-w-0 flex-1 gap-2">
          <main className="chrome-surface relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {core === 'ready' ? (
              <Suspense fallback={null}>
                <View route={route} />
              </Suspense>
            ) : core === 'starting' ? (
              <BootScreen label="Conectando con el núcleo…" />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState
                  icon={Plug}
                  title={core === 'missing' ? 'Sin conexión con el núcleo' : 'El núcleo no responde'}
                  description={
                    core === 'missing'
                      ? 'Abre el orquestador desde el escritorio, o usa el enlace «Abrir en el navegador» que trae el token de la sesión.'
                      : (coreError ?? 'Revisa que el núcleo esté corriendo.')
                  }
                />
              </div>
            )}
          </main>
          {panel.shown ? <AgentsPanel overlay={!panel.inline} onClose={() => panel.toggle(false)} /> : null}
        </div>
      </div>
    </div>
  );
}
