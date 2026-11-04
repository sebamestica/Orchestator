import { z } from 'zod';

/** Identificador estable: minúsculas, dígitos y guiones. */
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

export const agentKindSchema = z.enum(['claude-sdk', 'codex-cli', 'agy-cli', 'api']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const providerSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'openai-compatible',
  'codex',
  'antigravity',
]);
export type Provider = z.infer<typeof providerSchema>;

/** Configuración persistida de un agente. Nunca contiene la clave: solo `secretRef` (id en la bóveda). */
export const agentConfigSchema = z.strictObject({
  id: idSchema,
  kind: agentKindSchema,
  provider: providerSchema,
  displayName: z.string().min(1).max(80),
  model: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  secretRef: idSchema.optional(),
  /** Fracción de cupo (0–1) por debajo de la cual el router deja de asignarle tareas. */
  quotaFloor: z.number().min(0).max(1).default(0.2),
  /** Tope de gasto en USD para agentes sin saldo consultable (p. ej. tu clave de Claude). */
  budgetUsd: z.number().positive().optional(),
  enabled: z.boolean().default(true),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const quotaMethodSchema = z.enum([
  'agy-usage',
  'codex-ratelimits',
  'openrouter-key',
  'response-headers',
  'manual-budget',
  'none',
]);
export type QuotaMethod = z.infer<typeof quotaMethodSchema>;

export const probeResultSchema = z.strictObject({
  agentId: idSchema,
  installed: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().optional(),
  models: z.array(z.string()),
  quotaMethod: quotaMethodSchema,
  warnings: z.array(z.string()),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;
