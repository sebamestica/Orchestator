import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage, Workspace, WorkspaceManager } from '../../shared/index.ts';
import { ApiChatAdapter } from '../adapters/api/index.ts';
import { estimateCostUsd } from '../adapters/claude-sdk/index.ts';
import { AGENT_HUB_DIR } from '../skills/index.ts';
import type { ProjectRecord } from '../store/index.ts';
import type { ApiAdapterFactory } from './adapters.ts';
import { CommittingWorkspaces } from './commit-step.ts';
import { ProjectWorktrees } from './workspaces.ts';

/** Costo de una respuesta de la API de Anthropic con precios públicos (para el presupuesto manual). */
export function anthropicCostUsd(usage: Usage): number {
  const cached = usage.cachedInputTokens ?? 0;
  return estimateCostUsd(usage.model, { input: Math.max(0, usage.inputTokens - cached), output: usage.outputTokens, cacheRead: cached, cacheWrite: 0 });
}

/**
 * Hueco de c6: `ApiChatAdapter` con la clave de la bóveda. El costo se estima solo para Anthropic (la tabla de precios
 * es la de Claude): sin estimación, el gasto no se descuenta y el adaptador no pide `budgetUsd`. Si se suma otro
 * proveedor, cambiar también `countsSpend` en src/ui/features/settings/AgentsSection.tsx.
 */
export function defaultApiAdapter(fetch?: typeof globalThis.fetch): ApiAdapterFactory {
  return (config, secrets) =>
    new ApiChatAdapter({
      config,
      getApiKey: () => secrets.apiKey,
      ...(config.provider === 'anthropic' ? { estimateCostUsd: anthropicCostUsd } : {}),
      ...(fetch ? { fetch } : {}),
    });
}

/** Carpeta de skills del hub que los workers Claude pueden leer (nota de c1), si existe. */
export function skillsReadRoot(hubDir?: string): string | undefined {
  const dir = join(hubDir ?? AGENT_HUB_DIR, 'skills');
  return existsSync(dir) ? dir : undefined;
}

export interface WorkspacesInput {
  /** Gestor ya armado (gana sobre `projects`). */
  workspaces?: WorkspaceManager;
  /** Configuración de c3 por proyecto (con `gate`). */
  projects?: readonly unknown[];
  storeProject: (projectId: string) => ProjectRecord | undefined;
  log: (line: string) => void;
  /** Claves que Berland entregó a los agentes: el commit de la flota se niega si aparecen en el trabajo. */
  secrets?: () => readonly string[];
}

/** Worktrees de c3 por proyecto con el paso de commit de la flota (ownedPaths + commit antes de revisar). */
export function buildWorkspaces(input: WorkspacesInput): CommittingWorkspaces {
  const inner = input.workspaces ?? new ProjectWorktrees({ ...(input.projects ? { projects: input.projects } : {}), storeProject: input.storeProject, log: input.log });
  // ProjectWorktrees sabe la rama de integración con que se creó cada worktree; WorktreeManager, la de cada proyecto.
  const branchOf = inner instanceof ProjectWorktrees
    ? (id: string, ws: Workspace) => inner.projectOf(id, ws).integrationBranch
    : typeof (inner as { project?: unknown }).project === 'function'
      ? (id: string) => (inner as unknown as { project(id: string): { integrationBranch: string } }).project(id).integrationBranch
      : undefined;
  return new CommittingWorkspaces({ inner, log: input.log, ...(branchOf ? { integrationBranch: branchOf } : {}), ...(input.secrets ? { secrets: input.secrets } : {}) });
}
