import type { AgentConfig } from '../../shared/index.ts';
import { isStrippedEnvName } from '../process/child-env.ts';
import type { AgentRecord } from '../store/index.ts';
import type { SecretVault } from '../vault/index.ts';

/**
 * Variables de credenciales que nunca se heredan del entorno anfitrión: el agente usa solo la clave y la URL
 * guardadas en la bóveda y en su configuración (el usuario no puede iniciar sesión en Claude).
 */
export const HOST_CREDENTIAL_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/** Variable con la que el adaptador de API (c6) lee la clave en `run`. */
export const API_KEY_VAR = 'ORQ_API_KEY';

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

/** Entorno de un agente a partir de su configuración y su clave (solo en memoria). */
export function agentEnv(config: AgentConfig, apiKey: string | undefined): Readonly<Record<string, string>> {
  if (!apiKey) return EMPTY;
  if (config.kind === 'claude-sdk') {
    return Object.freeze({ ANTHROPIC_API_KEY: apiKey, ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}) });
  }
  if (config.kind === 'api') return Object.freeze({ [API_KEY_VAR]: apiKey });
  return EMPTY;
}

/**
 * Entorno anfitrión sin credenciales de IA ni variables de una sesión de Claude Code (misma lista que
 * `childEnv`), para que no pisen ni suplanten las de la bóveda.
 */
export function withoutHostCredentials(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !HOST_CREDENTIAL_VARS.includes(k.toUpperCase()) && !isStrippedEnvName(k)) out[k] = v;
  }
  return out;
}

/** Agentes cuyo proceso necesita la clave en el entorno. */
export function needsKeyInEnv(config: AgentConfig): boolean {
  return (config.kind === 'claude-sdk' || config.kind === 'api') && config.secretRef !== undefined;
}

export class AgentEnvError extends Error {
  override readonly name = 'AgentEnvError';
}

export interface AgentEnvironmentOptions {
  agents: { getAgent(id: string): AgentRecord | undefined; listAgents(): AgentRecord[] };
  vault: Pick<SecretVault, 'get'>;
}

/** Entrada de la caché: el entorno y la configuración con la que se cargó. */
interface CachedEnv {
  env: Readonly<Record<string, string>>;
  kind: AgentConfig['kind'];
  secretRef: string | undefined;
  baseUrl: string | undefined;
}

/**
 * Claves de los agentes, leídas de la bóveda y guardadas solo en memoria. `envFor` es síncrona porque así la
 * pide `Supervisor` (opción `env`): antes hay que cargar la clave con `load` o `loadAll`.
 * - Generaciones: un `load` pendiente no guarda nada si entretanto se llamó a `forget` (hallazgo 3 de Codex).
 * - `envFor` solo entrega la caché si el agente vigente tiene el mismo tipo, `secretRef` y URL que al cargarla:
 *   un agente reemplazado por otro tipo nunca recibe la clave del anterior.
 * Nada de esto se registra: los errores nombran al agente, nunca el valor.
 */
export class AgentEnvironment {
  readonly #opts: AgentEnvironmentOptions;
  readonly #cache = new Map<string, CachedEnv>();
  readonly #generation = new Map<string, number>();
  #epoch = 0;

  constructor(opts: AgentEnvironmentOptions) {
    this.#opts = opts;
  }

  #stamp(agentId: string): string {
    return `${this.#epoch}:${this.#generation.get(agentId) ?? 0}`;
  }

  /** Lee la clave del agente en la bóveda y deja su entorno listo para `envFor`. */
  async load(agentId: string): Promise<Readonly<Record<string, string>>> {
    const stamp = this.#stamp(agentId);
    const agent = this.#opts.agents.getAgent(agentId);
    if (!agent) throw new AgentEnvError(`No existe el agente ${agentId}`);
    const { config } = agent;
    let env = EMPTY;
    if (needsKeyInEnv(config) && config.secretRef) {
      const apiKey = await this.#opts.vault.get(config.secretRef);
      if (apiKey === undefined) throw new AgentEnvError(`Falta la clave del agente ${agentId} en la bóveda`);
      env = agentEnv(config, apiKey);
    }
    if (this.#stamp(agentId) !== stamp) throw new AgentEnvError(`El agente ${agentId} cambió mientras se cargaba su clave; vuelve a cargarla`);
    this.#cache.set(agentId, { env, kind: config.kind, secretRef: config.secretRef, baseUrl: config.baseUrl });
    return env;
  }

  /** Carga los agentes indicados (por defecto, todos los habilitados que usan clave). */
  async loadAll(agentIds?: readonly string[]): Promise<void> {
    const ids = agentIds ?? this.#opts.agents.listAgents().filter((a) => a.config.enabled && needsKeyInEnv(a.config)).map((a) => a.config.id);
    for (const id of ids) await this.load(id);
  }

  /** Entorno del agente para `Supervisor`. Lanza si el agente usa clave y no está cargada (o cambió desde que se cargó). */
  readonly envFor = (agentId: string): Readonly<Record<string, string>> => {
    const agent = this.#opts.agents.getAgent(agentId);
    const cached = this.#cache.get(agentId);
    if (cached) {
      const c = agent?.config;
      if (c && c.kind === cached.kind && c.secretRef === cached.secretRef && c.baseUrl === cached.baseUrl) return cached.env;
      this.#cache.delete(agentId);
    }
    if (agent && needsKeyInEnv(agent.config)) {
      throw new AgentEnvError(`La clave del agente ${agentId} no está cargada o el agente cambió (llama a load antes de ejecutar)`);
    }
    return EMPTY;
  };

  /** Olvida las claves en memoria (de un agente o de todos) e invalida las cargas en curso. */
  forget(agentId?: string): void {
    if (agentId) {
      this.#generation.set(agentId, (this.#generation.get(agentId) ?? 0) + 1);
      this.#cache.delete(agentId);
    } else {
      this.#epoch++;
      this.#cache.clear();
    }
  }

  /** Agentes con entorno cargado (sin valores). */
  loaded(): string[] {
    return [...this.#cache.keys()];
  }
}
