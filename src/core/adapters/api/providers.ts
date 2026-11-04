import type { Provider } from '../../../shared/index.ts';

/** Proveedores de chat por API que cubre este adaptador. */
export const API_PROVIDERS = ['anthropic', 'openai', 'openai-compatible', 'google', 'openrouter'] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

export function isApiProvider(provider: Provider): provider is ApiProvider {
  return (API_PROVIDERS as readonly string[]).includes(provider);
}

/** Variable de `ctx.env` donde el núcleo entrega la clave (solo en memoria). */
export const API_KEY_ENV = 'ORQ_API_KEY';

export interface ProviderInfo {
  label: string;
  /** URL base por defecto; sin ella, `config.baseUrl` es obligatoria. */
  defaultBaseUrl?: string;
  /** Nombres alternativos de la clave en `ctx.env`, después de `ORQ_API_KEY`. */
  keyEnv: readonly string[];
  /** False en servidores compatibles locales (Ollama, LM Studio) que no piden clave. */
  keyRequired: boolean;
  /** Modelo si `config.model` no viene. */
  defaultModel?: string;
}

export const PROVIDERS: Readonly<Record<ApiProvider, ProviderInfo>> = {
  anthropic: {
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyEnv: ['ANTHROPIC_API_KEY'],
    keyRequired: true,
    defaultModel: 'claude-opus-5-5',
  },
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    keyRequired: true,
  },
  'openai-compatible': {
    label: 'Compatible con OpenAI',
    keyEnv: [],
    keyRequired: false,
  },
  google: {
    label: 'Google (Gemini API)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    keyRequired: true,
  },
  openrouter: {
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY'],
    keyRequired: true,
  },
};

/** URL base efectiva sin barra final; undefined si el proveedor la exige y falta. */
export function resolveBaseUrl(provider: ApiProvider, configBaseUrl: string | undefined): string | undefined {
  const url = configBaseUrl ?? PROVIDERS[provider].defaultBaseUrl;
  return url?.replace(/\/+$/, '');
}

/** Clave desde `ctx.env`: primero `ORQ_API_KEY`, luego los nombres propios del proveedor. */
export function apiKeyFromEnv(provider: ApiProvider, env: Readonly<Record<string, string>>): string | undefined {
  for (const name of [API_KEY_ENV, ...PROVIDERS[provider].keyEnv]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function isInsecureUrl(url: string): boolean {
  return /^http:\/\//i.test(url);
}

/** Advertencia visible cuando la URL base no usa TLS. */
export function insecureUrlWarning(url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* URL ya validada por agentConfigSchema; se muestra tal cual */
  }
  return `Conexión sin cifrar: ${origin} usa http://, así que la clave, los encargos y las respuestas viajan en claro.`;
}
