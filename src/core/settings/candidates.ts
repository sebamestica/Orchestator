import type { AgentConfig, MindCandidate, Settings } from '../../shared/index.ts';
import type { AgentRecord } from '../store/index.ts';

/** Codex y agy como mente necesitan las herramientas del orquestador por MCP sobre HTTP (fase F5.2). */
export const MIND_BRIDGE_NOTE = 'necesita el puente MCP (F5.2)';
export const MIND_API_NOTE = 'los modelos por API no tienen herramientas: no pueden ser la mente';
export const MIND_DISABLED_NOTE = 'agente deshabilitado: habilítalo en Agentes';

const ORDER: Readonly<Record<MindCandidate['support'], number>> = { full: 0, experimental: 1, none: 2 };

/** Qué puede hacer cada agente como mente. */
export function mindSupport(agent: AgentRecord): Pick<MindCandidate, 'support' | 'note'> {
  if (!agent.config.enabled) return { support: 'none', note: MIND_DISABLED_NOTE };
  switch (agent.config.kind) {
    case 'claude-sdk':
      return { support: 'full' };
    case 'codex-cli':
    case 'agy-cli':
      return { support: 'experimental', note: MIND_BRIDGE_NOTE };
    case 'api':
      return { support: 'none', note: MIND_API_NOTE };
  }
}

/**
 * Candidatos a mente (`GET /mind/candidates`): Claude (`claude-sdk`) habilitado es mente completa; Codex y agy,
 * experimentales hasta el puente MCP; los modelos por API y los deshabilitados, no. Primero los completos. Los
 * modelos salen de la última prueba (`lastProbe.models`), con el modelo configurado del agente delante.
 */
export function mindCandidates(agents: readonly AgentRecord[]): MindCandidate[] {
  const out = agents.map((agent): MindCandidate => {
    const { support, note } = mindSupport(agent);
    const models = [...new Set([...(agent.config.model ? [agent.config.model] : []), ...(agent.lastProbe?.models ?? [])])];
    return {
      agentId: agent.config.id,
      displayName: agent.config.displayName,
      kind: agent.config.kind,
      support,
      ...(note ? { note } : {}),
      models,
    };
  });
  // `sort` es estable: dentro de cada nivel se conserva el orden del registro.
  return out.sort((a, b) => ORDER[a.support] - ORDER[b.support]);
}

/**
 * Agente cuya clave paga la mente (su gasto se guarda como `orquestador`): el elegido en Ajustes o, sin elección, el
 * primer Claude (`claude-sdk`) habilitado, como en `resolveMind`, pero sin validarlo ni lanzar.
 */
export function mindAgentId(settings: Settings, agents: readonly AgentConfig[]): string | undefined {
  return settings.mind.agentId ?? agents.find((a) => a.kind === 'claude-sdk' && a.enabled)?.id;
}
