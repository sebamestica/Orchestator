import { Button } from '@heroui/react';
import { Plug } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { resolveCore } from '../api/bridge.ts';
import { setCoreEndpoint } from '../api/client.ts';
import { startLive } from '../api/live.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { AgentsPanel } from '../features/agents-panel/AgentsPanel.tsx';
import { HomeView } from '../features/home/HomeView.tsx';
import { useApp } from '../store/app.ts';
import { Sidebar } from './Sidebar.tsx';
import { TitleBar } from './TitleBar.tsx';
import { routeHash, type Route } from './routes.ts';
import { useAgentsPanel } from './use-agents-panel.ts';
import { useAppearance } from './use-appearance.ts';
import { useRoute } from './use-route.ts';
import { ViewBoundary } from './ViewBoundary.tsx';
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
      return <BoardView {...(route.projectId ? { projectId: route.projectId } : {})} openManual={route.nueva === true} />;
    case 'settings':
      return <SettingsView section={route.section} />;
    case 'plugins':
      return <PluginsView />;
  }
}

const MISSING_HINT = 'Abre Berland desde el escritorio, o abre el enlace «web:» que muestra el núcleo al iniciar (trae el token de la sesión).';

/** Conecta con el núcleo al montar y cada vez que se llama a `retry()` (que vuelve a «Conectando…»). */
function useBootstrap(): () => void {
  const setCore = useApp((s) => s.setCore);
  const setLive = useApp((s) => s.setLive);
  const loadAll = useApp((s) => s.loadAll);
  const applyLive = useApp((s) => s.applyLive);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const core = await resolveCore();
        if (cancelled) return;
        if (!core) {
          setCore('missing');
          return;
        }
        setCoreEndpoint(core);
        await loadAll();
        // Un intento que ya se reemplazó no abre su propio socket.
        if (cancelled) return;
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
        if (!cancelled) setCore('error', err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [setCore, setLive, loadAll, applyLive, attempt]);
  return useCallback(() => {
    setCore('starting');
    setAttempt((n) => n + 1);
  }, [setCore]);
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

export function App() {
  const retry = useBootstrap();
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
              <ViewBoundary resetKey={routeHash(route)}>
                <Suspense fallback={null}>
                  <View route={route} />
                </Suspense>
              </ViewBoundary>
            ) : core === 'starting' ? (
              <BootScreen label="Conectando con el núcleo…" />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState
                  icon={Plug}
                  title={core === 'missing' ? 'Sin conexión con el núcleo' : 'El núcleo no responde'}
                  description={core === 'missing' ? MISSING_HINT : (coreError ?? 'Revisa que el núcleo esté corriendo.')}
                  action={
                    core === 'error' ? (
                      <Button variant="secondary" size="sm" onPress={retry}>
                        Reintentar
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            )}
          </main>
          {panel.shown ? (
            <ViewBoundary
              className={`chrome-surface ${panel.inline ? 'flex shrink-0' : 'absolute top-0 right-2 bottom-2 z-30 flex shadow-xl'} w-[var(--panel-width)] flex-col items-center justify-center`}
            >
              <AgentsPanel overlay={!panel.inline} onClose={() => panel.toggle(false)} />
            </ViewBoundary>
          ) : null}
        </div>
      </div>
    </div>
  );
}
