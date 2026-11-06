import type { AgentConfig, QuotaMethod, QuotaProvider } from '../../shared/index.ts';
import { AgyQuotaProvider } from '../quota/agy.ts';
import { CodexQuotaProvider } from '../quota/codex.ts';
import { ManualBudgetQuota, type SpentUsdFn } from '../quota/manual-budget.ts';
import { OpenRouterQuota } from '../quota/openrouter.ts';
import type { QuotaProviderFactory } from '../registry/index.ts';

/** Método de cupo si el agente aún no tiene uno guardado por su `probe`. */
export function defaultQuotaMethod(config: AgentConfig): QuotaMethod {
  if (config.kind === 'agy-cli') return 'agy-usage';
  if (config.kind === 'codex-cli') return 'codex-ratelimits';
  if (config.provider === 'openrouter') return 'openrouter-key';
  return config.budgetUsd !== undefined ? 'manual-budget' : 'none';
}

export interface QuotaFactoryOptions {
  /** La misma función de gasto que usa el adaptador para su tope (`billedSpentUsd`: incluye a la mente). */
  spentUsd: (agentId: string) => SpentUsdFn;
  fetch?: typeof globalThis.fetch;
}

/**
 * Lector de cupo según el método del agente: agy `/usage`, rate limits de Codex, `/key` de OpenRouter o presupuesto
 * manual (`budgetUsd` − gasto en SQLite) para la clave de Claude, cuyo servidor no informa saldo.
 * `response-headers` lo alimenta el adaptador de API (c6) y `none` no tiene lector.
 */
export function createQuotaProviderFactory(opts: QuotaFactoryOptions): QuotaProviderFactory {
  return (agent, secrets): QuotaProvider | undefined => {
    const { config } = agent;
    const agentId = config.id;
    const method = agent.quotaMethod ?? defaultQuotaMethod(config);
    switch (method) {
      case 'agy-usage':
        return new AgyQuotaProvider({ agentId });
      case 'codex-ratelimits':
        return new CodexQuotaProvider(agentId);
      case 'openrouter-key':
        return new OpenRouterQuota({ agentId, getApiKey: () => secrets.apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
      case 'manual-budget':
        return config.budgetUsd === undefined ? undefined : new ManualBudgetQuota({ agentId, budgetUsd: config.budgetUsd, spentUsd: opts.spentUsd(agentId) });
      case 'response-headers':
      case 'none':
        return undefined;
    }
  };
}
