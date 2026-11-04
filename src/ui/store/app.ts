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
  /** Panel derecho de agentes en vivo. */
  panelOpen: boolean;
  projects: ProjectRecord[];
  agents: AgentRecord[];
  settings: Settings;
  quotas: Record<string, QuotaRecord>;
  tasks: Record<string, TaskRecord>;
  setCore(core: CoreStatus, error?: string): void;
  setLive(live: LiveStatus): void;
  toggleSidebar(): void;
  togglePanel(open?: boolean): void;
  loadAll(): Promise<void>;
  refreshProjects(): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshTasks(): Promise<void>;
  setSettings(settings: Settings): void;
  applyLive(message: LiveMessage): void;
}

const ignore = () => undefined;

export const useApp = create<AppState>((set, get) => ({
  core: 'starting',
  coreError: null,
  live: 'closed',
  sidebarCollapsed: false,
  panelOpen: true,
  projects: [],
  agents: [],
  settings: DEFAULT_SETTINGS,
  quotas: {},
  tasks: {},
  setCore: (core, error) => set({ core, coreError: error ?? null }),
  setLive: (live) => set({ live }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  togglePanel: (open) => set((s) => ({ panelOpen: open ?? !s.panelOpen })),
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
  async refreshProjects() {
    const r = await api.get<{ projects: ProjectRecord[] }>('/projects');
    set({ projects: r.projects });
  },
  async refreshAgents() {
    const r = await api.get<{ agents: AgentRecord[] }>('/agents');
    set({ agents: r.agents });
  },
  async refreshTasks() {
    const r = await api.get<{ tasks: TaskRecord[] }>('/tasks');
    set({ tasks: Object.fromEntries(r.tasks.map((t) => [t.task.id, t])) });
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
