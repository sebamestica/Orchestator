import { z } from 'zod';

/**
 * Esquemas Zod (tolerantes: `looseObject`) del subconjunto de mensajes del SDK de agentes de Claude
 * (`@anthropic-ai/claude-agent-sdk` 0.3.302, tipos de `sdk.d.ts`) que usa el adaptador. Solo se exigen
 * los campos que se leen: un campo nuevo del SDK no rompe la traducción, y un mensaje que no encaja
 * se emite como `raw`.
 */

export const contentBlockSchema = z.looseObject({ type: z.string() });

export const textBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() });
export const thinkingBlockSchema = z.looseObject({ type: z.literal('thinking'), thinking: z.string() });
export const toolUseBlockSchema = z.looseObject({
  type: z.enum(['tool_use', 'server_tool_use', 'mcp_tool_use']),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
export const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().nullable().optional(),
  content: z.unknown().optional(),
});

/** Uso por modelo (`ModelUsage`), igual en `result.modelUsage` y en `usage_report.session.model_usage`. */
export const modelUsageSchema = z.looseObject({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  thinkingTokens: z.number().nonnegative().optional(),
  cacheReadInputTokens: z.number().nonnegative().optional(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
});
export type ModelUsageInfo = z.infer<typeof modelUsageSchema>;

const usageReportSchema = z.looseObject({
  session: z.looseObject({
    total_cost_usd: z.number().nonnegative(),
    model_usage: z.record(z.string(), modelUsageSchema).optional(),
  }),
});

export const assistantMessageSchema = z.looseObject({
  type: z.literal('assistant'),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  /** `SDKAssistantMessageError`: authentication_failed, billing_error, rate_limit… */
  error: z.string().optional(),
  /** Mensaje sintético con el texto de un error de la API (modelo `<synthetic>`). */
  is_api_error_message: z.boolean().optional(),
  api_error_status: z.number().nullable().optional(),
  message: z.looseObject({
    /** Varios mensajes seguidos pueden compartir `id` (uno por bloque); su `usage` no es definitivo. */
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(contentBlockSchema),
    usage: z
      .looseObject({
        input_tokens: z.number().nonnegative().nullable().optional(),
        output_tokens: z.number().nonnegative().nullable().optional(),
        cache_creation_input_tokens: z.number().nonnegative().nullable().optional(),
        cache_read_input_tokens: z.number().nonnegative().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  usage_report: usageReportSchema.nullable().optional(),
});

export const userMessageSchema = z.looseObject({
  type: z.literal('user'),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(contentBlockSchema)]) }),
  tool_use_result: z.unknown().optional(),
});

export const systemMessageSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.string(),
  session_id: z.string().optional(),
});

export const initMessageSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  model: z.string(),
  claude_code_version: z.string().optional(),
  cwd: z.string().optional(),
  permissionMode: z.string().optional(),
  apiKeySource: z.string().optional(),
});

const taskUsageSchema = z.looseObject({
  total_tokens: z.number().nonnegative(),
  tool_uses: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
});

export const taskStartedSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_started'),
  task_id: z.string().min(1),
  tool_use_id: z.string().optional(),
  description: z.string(),
  subagent_type: z.string().optional(),
});

export const taskProgressSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_progress'),
  task_id: z.string().min(1),
  tool_use_id: z.string().optional(),
  description: z.string(),
  summary: z.string().optional(),
  last_tool_name: z.string().optional(),
  usage: taskUsageSchema.optional(),
});

export const taskUpdatedSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_updated'),
  task_id: z.string().min(1),
  patch: z.looseObject({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'killed', 'paused']).optional(),
    description: z.string().optional(),
    error: z.string().optional(),
  }),
});

export const taskNotificationSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_notification'),
  task_id: z.string().min(1),
  tool_use_id: z.string().optional(),
  status: z.enum(['completed', 'failed', 'stopped']),
  summary: z.string(),
  usage: taskUsageSchema.optional(),
});

/** `system/status`: el SDK está compactando (`compacting`), pidiendo (`requesting`) o nada; al compactar, su resultado. */
export const sdkStatusSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('status'),
  status: z.string().nullable().optional(),
  compact_result: z.string().optional(),
  compact_error: z.string().optional(),
});

export const apiRetrySchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  attempt: z.number(),
  max_retries: z.number(),
  retry_delay_ms: z.number(),
  error_status: z.number().nullable(),
  error: z.string(),
});

export const resultMessageSchema = z.looseObject({
  type: z.literal('result'),
  /** success | error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries */
  subtype: z.string(),
  is_error: z.boolean(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().nonnegative(),
  usage: z.looseObject({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    cache_read_input_tokens: z.number().nonnegative().nullable().optional(),
    cache_creation_input_tokens: z.number().nonnegative().nullable().optional(),
  }),
  modelUsage: z.record(z.string(), modelUsageSchema),
  errors: z.array(z.string()).optional(),
  api_error_status: z.number().nullable().optional(),
});
export type ResultMessage = z.infer<typeof resultMessageSchema>;

export const authStatusSchema = z.looseObject({
  type: z.literal('auth_status'),
  isAuthenticating: z.boolean().optional(),
  error: z.string().optional(),
});

export const rateLimitEventSchema = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({ status: z.string(), resetsAt: z.number().optional() }),
});

/** Cualquier mensaje con `type` (para distinguir «desconocido» de «no es un objeto»). */
export const anyMessageSchema = z.looseObject({ type: z.string() });
