import type { AgentAdapter, AgentConfig } from '../../shared/index.ts';
import { AgyCliAdapter } from '../adapters/agy-cli/index.ts';
import { ClaudeSdkAdapter, type ClaudeSdkAdapterOptions } from '../adapters/claude-sdk/index.ts';
import { CodexCliAdapter, type CodexAdapterOptions } from '../adapters/codex-cli/index.ts';
import type { McpServerSource } from '../plugins/mcp.ts';
import type { LiveSpendEntry } from '../quota/live-spend.ts';
import type { SpentUsdFn } from '../quota/manual-budget.ts';
import type { AdapterFactory, AgentSecrets } from '../registry/index.ts';
import { agentEnv, withoutHostCredentials } from './env.ts';

/** Opciones de `ClaudeSdkAdapter` que la composición deja configurar (el resto lo decide ella). */
export type ClaudeTuning = Pick<
  ClaudeSdkAdapterOptions,
  'extraOptions' | 'settingSources' | 'query' | 'onSdkMessage' | 'probeTimeoutMs' | 'sdkVersion' | 'readOnlyPaths' | 'extraTools'
>;

/** Hueco de c6: adaptador de chat por API (`ApiChatAdapter`). Hasta que se conecte, `kind: 'api'` falla con un mensaje claro. */
export type ApiAdapterFactory = (config: AgentConfig, secrets: AgentSecrets) => AgentAdapter;

/** Constructores inyectables (pruebas): por defecto los adaptadores reales. */
export interface AdapterConstructors {
  claudeSdk: (opts: ClaudeSdkAdapterOptions) => AgentAdapter;
  codexCli: (config: AgentConfig, opts?: CodexAdapterOptions) => AgentAdapter;
  agyCli: (config: AgentConfig) => AgentAdapter;
}

export const DEFAULT_CONSTRUCTORS: AdapterConstructors = {
  claudeSdk: (opts) => new ClaudeSdkAdapter(opts),
  codexCli: (config, opts) => new CodexCliAdapter(config, opts),
  agyCli: (config) => new AgyCliAdapter(config),
};

export interface AdapterFactoryOptions {
  /** Gasto cobrado a la clave del agente (`billedSpentUsd`). La misma función alimenta el tope del adaptador y el cupo manual. */
  spentUsd: (agentId: string) => SpentUsdFn;
  /** Abre la cuenta en curso de una ejecución Claude en el saldo común de su clave (`LiveSpend.open`). */
  liveSpend?: (agentId: string) => LiveSpendEntry;
  /** Entorno anfitrión (por defecto `process.env`); se le quitan las credenciales de Anthropic. */
  hostEnv?: () => Readonly<Record<string, string | undefined>>;
  /** `fetch` del `probe` de Claude (pruebas o proxy). */
  fetch?: typeof globalThis.fetch;
  claude?: ClaudeTuning;
  api?: ApiAdapterFactory;
  constructors?: Partial<AdapterConstructors>;
  /** Servidores MCP de los plugins (c16, `PluginService.source()`) para Claude y Codex. agy aún no los recibe. */
  plugins?: McpServerSource;
}

export class AdapterFactoryError extends Error {
  override readonly name = 'AdapterFactoryError';
}

/**
 * Fábrica de adaptadores según `config.kind`. Claude recibe la clave de la bóveda (`secrets.apiKey`) y la URL de su
 * configuración, nunca del entorno anfitrión: su `probe` usa solo esas dos, y su proceso parte de un entorno sin
 * credenciales al que se suman clave y URL (luego `ctx.env` encima, como siempre).
 */
export function createAdapterFactory(opts: AdapterFactoryOptions): AdapterFactory {
  const make = { ...DEFAULT_CONSTRUCTORS, ...opts.constructors };
  const hostEnv = opts.hostEnv ?? (() => process.env);
  const liveSpend = opts.liveSpend;
  return (config, secrets) => {
    switch (config.kind) {
      case 'claude-sdk': {
        const keyEnv = agentEnv(config, secrets.apiKey);
        return make.claudeSdk({
          ...opts.claude,
          config,
          baseEnv: { ...withoutHostCredentials(hostEnv()), ...keyEnv },
          probeEnv: () => keyEnv,
          spentUsd: opts.spentUsd(config.id),
          ...(liveSpend ? { liveSpend: () => liveSpend(config.id) } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.plugins ? { plugins: opts.plugins } : {}),
        });
      }
      case 'codex-cli':
        return opts.plugins ? make.codexCli(config, { plugins: opts.plugins }) : make.codexCli(config);
      case 'agy-cli':
        return make.agyCli(config);
      case 'api':
        if (opts.api) return opts.api(config, secrets);
        throw new AdapterFactoryError(`El adaptador de API para ${config.id} (${config.provider}) está pendiente (c6)`);
    }
  };
}
