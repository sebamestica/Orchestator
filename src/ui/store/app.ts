/**
 * Estado global de la interfaz: conexión, proyectos, agentes, ajustes, cupos y tareas.
 * Cada vista de feature guarda lo suyo en su propia carpeta (chats, plugins…).
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api.ts';
import { api } from '../api/client.ts';
import type { LiveMessage, LiveStatus } from '../api/live.ts';
import type { AgentRecord, ProjectRecord, QuotaRecord, TaskRecord } from '../api/types.ts';

export type CoreStatus = 'starting' | 'ready' | 'missing' | 'error';

interface AppState {
  core: CoreStatus;
  coreError: string | null;
  live: LiveStatus;
  sidebarCollapsed: boolean;
  /** Panel derecho de agentes en vivo, cuando cabe en línea. */
  panelOpen: boolean;
  /** El mismo panel superpuesto, en ventanas angostas (empieza cerrado). */
  panelOverlayOpen: boolean;
  projects: ProjectRecord[];
  agents: AgentRecord[];
  settings: Settings;
  quotas: Record<string, QuotaRecord>;
  tasks: Record<string, TaskRecord>;
  setCore(core: CoreStatus, error?: string): void;
  /** Guarda el estado de `/ws` y, al quedar abierto, vuelve a pedir la foto (el núcleo no repite lo perdido). */
  setLive(live: LiveStatus): void;
  toggleSidebar(): void;
  togglePanel(open?: boolean): void;
  togglePanelOverlay(open?: boolean): void;
  loadAll(): Promise<void>;
  /** `loadAll` sin errores y de a una: si se pide con otra en vuelo, se repite una vez al terminar. */
  resync(): Promise<void>;
  refreshProjects(): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshTasks(): Promise<void>;
  setSettings(settings: Settings): void;
  applyLive(message: LiveMessage): void;
}

const ignore = () => undefined;

/**
 * Une la foto HTTP con lo que `/ws` trajo mientras se pedía. Manda la foto, salvo los registros que cambiaron en
 * vuelo (ya no son los de `before`): esos se quedan si son más nuevos que los de la foto o si la foto aún no los tiene,
 * y los que se borraron en vuelo no vuelven.
 */
function mergeSnapshot<T extends { updatedAt: string }>(
  snapshot: readonly T[],
  current: readonly T[],
  before: readonly T[],
  idOf: (record: T) => string,
): T[] {
  const merged = new Map(snapshot.map((r) => [idOf(r), r] as const));
  const untouched = new Set(before);
  for (const r of current) {
    if (untouched.has(r)) continue;
    const snap = merged.get(idOf(r));
    if (!snap || r.updatedAt > snap.updatedAt) merged.set(idOf(r), r);
  }
  const alive = new Set(current.map(idOf));
  for (const r of before) if (!alive.has(idOf(r))) merged.delete(idOf(r));
  return [...merged.values()];
}

const taskId = (t: TaskRecord) => t.task.id;
const agentId = (a: AgentRecord) => a.config.id;

let resyncing: Promise<void> | null = null;
let resyncAgain = false;

export const useApp = create<AppState>((set, get) => ({
  core: 'starting',
  coreError: null,
  live: 'closed',
  sidebarCollapsed: false,
  panelOpen: true,
  panelOverlayOpen: false,
  projects: [],
  agents: [],
  settings: DEFAULT_SETTINGS,
  quotas: {},
  tasks: {},
  setCore: (core, error) => set({ core, coreError: error ?? null }),
  setLive: (live) => {
    set({ live });
    if (live === 'open') void get().resync();
  },
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  togglePanel: (open) => set((s) => ({ panelOpen: open ?? !s.panelOpen })),
  togglePanelOverlay: (open) => set((s) => ({ panelOverlayOpen: open ?? !s.panelOverlayOpen })),
  async loadAll() {
    const s = get();
    await Promise.all([
      s.refreshProjects(),
      s.refreshAgents(),
      s.refreshTasks(),
      api.get<{ quotas: QuotaRecord[] }>('/quotas').then(
        (r) => set({ quotas: Object.fromEntries(r.quotas.map((q) => [q.snapshot.agentId, q])) }),
        ignore,
      ),
      // `/settings` llega con c14; mientras tanto se usan los valores por defecto.
      api.get<{ settings: Settings }>('/settings').then((r) => set({ settings: r.settings }), ignore),
    ]);
  },
  resync() {
    if (resyncing) {
      resyncAgain = true;
      return resyncing;
    }
    resyncing = (async () => {
      do {
        resyncAgain = false;
        await get().loadAll().catch(ignore);
      } while (resyncAgain);
    })().finally(() => {
      resyncing = null;
    });
    return resyncing;
  },
  async refreshProjects() {
    const r = await api.get<{ projects: ProjectRecord[] }>('/projects');
    set({ projects: r.projects });
  },
  async refreshAgents() {
    const before = get().agents;
    const r = await api.get<{ agents: AgentRecord[] }>('/agents');
    set((s) => ({ agents: mergeSnapshot(r.agents, s.agents, before, agentId) }));
  },
  async refreshTasks() {
    const before = Object.values(get().tasks);
    const r = await api.get<{ tasks: TaskRecord[] }>('/tasks');
    set((s) => ({ tasks: Object.fromEntries(mergeSnapshot(r.tasks, Object.values(s.tasks), before, taskId).map((t) => [taskId(t), t])) }));
  },
  setSettings: (settings) => set({ settings }),
  applyLive(message) {
    switch (message.type) {
      case 'agent':
        set((s) => ({ agents: [...s.agents.filter((a) => a.config.id !== message.agent.config.id), message.agent] }));
        break;
      case 'agent_deleted':
        set((s) => ({ agents: s.agents.filter((a) => a.config.id !== message.agentId) }));
        break;
      case 'task':
        set((s) => ({ tasks: { ...s.tasks, [message.task.task.id]: message.task } }));
        break;
      case 'quota':
        set((s) => ({ quotas: { ...s.quotas, [message.quota.snapshot.agentId]: message.quota } }));
        break;
      case 'settings':
        set({ settings: message.settings });
        break;
      default:
        break;
    }
  },
}));
