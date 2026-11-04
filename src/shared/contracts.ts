import type { AgentConfig, ProbeResult } from './agents.ts';
import type { AgentEvent } from './events.ts';
import type { QuotaSnapshot } from './quota.ts';
import type { RunContext, TaskBrief } from './tasks.ts';

/** Contrato que implementa cada adaptador de agente (claude-sdk, codex-cli, agy-cli, api). */
export interface AgentAdapter {
  readonly config: AgentConfig;
  /** Comprueba instalación, sesión y modelos sin gastar cupo (o el mínimo posible). */
  probe(): Promise<ProbeResult>;
  /** Ejecuta la tarea y emite eventos normalizados hasta un evento `done` (o `error` + `done`). */
  run(task: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent>;
}

/** Lee el cupo restante de un agente. Debe ser barata: se llama cada 5 min y al terminar cada tarea. */
export interface QuotaProvider {
  readonly agentId: string;
  read(): Promise<QuotaSnapshot>;
}

/** Carpeta de trabajo aislada por tarea (implementa src/core/workspace). */
export interface Workspace {
  taskId: string;
  path: string;
  branch: string;
}
export interface IntegrationResult {
  ok: boolean;
  /** Archivos en conflicto si el merge falló. */
  conflicts: string[];
  /** Salida resumida del gate (verificación del proyecto). */
  gateSummary: string;
  commit?: string;
}
export interface WorkspaceManager {
  create(projectId: string, task: TaskBrief): Promise<Workspace>;
  integrate(projectId: string, workspace: Workspace): Promise<IntegrationResult>;
  remove(workspace: Workspace): Promise<void>;
}

/** Persistencia de eventos y consumo (implementa src/core/store). */
export interface EventSink {
  append(event: AgentEvent): void;
}

/** Memoria en Obsidian (implementa src/core/memory). */
export interface SessionSummary {
  projectId: string;
  taskId: string;
  agentId: string;
  title: string;
  outcome: 'ok' | 'failed' | 'handed_off';
  summary: string;
  filesChanged: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  at: string;
}
export interface MemoryStore {
  /** Extractos breves y pertinentes para el encargo, dentro de un presupuesto de caracteres. */
  buildContext(projectId: string, task: TaskBrief, budgetChars: number): Promise<string>;
  recordSession(summary: SessionSummary): Promise<void>;
}
