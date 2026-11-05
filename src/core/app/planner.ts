import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AgentConfig, AgentEvent, EventSink } from '../../shared/index.ts';
import { redactSecrets } from '../../shared/index.ts';
import { DEFAULT_CLAUDE_MODEL, estimateCostUsd } from '../adapters/claude-sdk/index.ts';
import type { Effort } from '../brief/reasoning.ts';
import { planToTasks, type PlannerLlm, type PlannerRequest } from '../orchestrator/index.ts';
import { ApiError, type Planner } from '../server/index.ts';
import type { AgentRecord } from '../store/index.ts';
import type { SecretVault } from '../vault/index.ts';

/**
 * Planificador con Claude por la API de Mensajes (`@anthropic-ai/sdk`), con la misma clave (bóveda) y la misma URL
 * (`config.baseUrl`) que el agente Claude. Se eligió la API directa y no el adaptador claude-sdk sin herramientas:
 * planificar es una sola respuesta de texto, sin herramientas ni archivos; así no se lanza el proceso de Claude Code
 * ni se paga su prompt de sistema en cada intento, y el `fetch` se puede inyectar en las pruebas.
 *
 * Razonamiento (issue 6): planificar es pasar a JSON un plan que la mente ya escribió, así que va a Sonnet 5.5 con
 * esfuerzo `low` (antes, Opus en `medium`).
 */

export const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';
export const PLANNER_MAX_TOKENS = 16_000;
/** Modelo del planificador (decisión del usuario, issue 6). */
export const PLANNER_MODEL = 'claude-sonnet-5-5';
export const PLANNER_EFFORT: Effort = 'low';

export interface PlannerCredentials {
  config: AgentConfig;
  apiKey: string;
}

export type { Effort };

export interface ClaudePlannerLlmOptions {
  /** Agente y clave con los que se llama (se leen en cada llamada: sirve un agente agregado después de arrancar). */
  credentials: () => Promise<PlannerCredentials>;
  fetch?: typeof globalThis.fetch;
  /** Registra el consumo como una sesión del agente (cuenta para su presupuesto manual). */
  sink?: EventSink;
  /** Esfuerzo del modelo (por defecto `PLANNER_EFFORT`, `low`). */
  effort?: Effort;
  /** Modelo (por defecto `PLANNER_MODEL`, Sonnet 5.5); `null`: el del agente (`config.model` o Opus 5.5). */
  model?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export class PlannerLlmError extends Error {
  override readonly name = 'PlannerLlmError';
}

const responseSchema = z.looseObject({
  model: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
  }),
});
type PlannerResponse = z.infer<typeof responseSchema>;

function describeError(err: unknown, apiKey: string): string {
  let text: string;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) text = `el servidor rechazó la clave (HTTP ${err.status})`;
  else if (err instanceof Anthropic.APIConnectionError) text = `no se pudo conectar con el servidor: ${err.message}`;
  else if (err instanceof Anthropic.APIError) text = `el servidor respondió HTTP ${err.status}: ${err.message}`;
  else text = err instanceof Error ? err.message : String(err);
  return redactSecrets(`Planificador: ${text}`, [apiKey]).slice(0, 400);
}

/** `PlannerLlm` (de `planToTasks`) que llama a Claude con la clave y la URL del agente. */
export function createClaudePlannerLlm(opts: ClaudePlannerLlmOptions): PlannerLlm {
  return {
    async complete(request: PlannerRequest): Promise<string> {
      const { config, apiKey } = await opts.credentials();
      const model = opts.model === undefined ? PLANNER_MODEL : (opts.model ?? config.model ?? DEFAULT_CLAUDE_MODEL);
      const client = new Anthropic({
        apiKey,
        authToken: null,
        baseURL: config.baseUrl ?? DEFAULT_ANTHROPIC_URL,
        maxRetries: opts.maxRetries ?? 2,
        timeout: opts.timeoutMs ?? 300_000,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      let raw: unknown;
      try {
        raw = await client.messages.create(
          {
            model,
            max_tokens: opts.maxTokens ?? PLANNER_MAX_TOKENS,
            // La clave en uso se tacha en todo lo que sale (también en las reparaciones): `planToTasks` solo
            // reconoce patrones y una clave de un servidor propio puede no tener prefijo conocido.
            system: redactSecrets(request.system, [apiKey]),
            messages: request.messages.map((m) => ({ role: m.role, content: redactSecrets(m.content, [apiKey]) })),
            output_config: { effort: opts.effort ?? PLANNER_EFFORT },
          },
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (err) {
        throw new PlannerLlmError(describeError(err, apiKey));
      }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new PlannerLlmError('Planificador: respuesta del modelo con formato inesperado');
      const res = parsed.data;
      recordUsage(opts, config.id, model, res);
      if (res.stop_reason === 'refusal') throw new PlannerLlmError('Planificador: el modelo rechazó el plan (stop_reason refusal)');
      return res.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    },
  };
}

/** Sesión `plan-…` con el consumo de una llamada: `/usage` y el presupuesto manual la cuentan. */
function recordUsage(opts: ClaudePlannerLlmOptions, agentId: string, requested: string, res: PlannerResponse): void {
  if (!opts.sink) return;
  const u = res.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const model = res.model ?? requested;
  const costUsd = estimateCostUsd(model, { input: u.input_tokens, output: u.output_tokens, cacheRead, cacheWrite });
  const base = { sessionId: `plan-${randomUUID()}`, agentId };
  const ts = () => (opts.now?.() ?? new Date()).toISOString();
  const events: AgentEvent[] = [
    { ...base, seq: 0, ts: ts(), type: 'status', payload: { state: 'running', detail: `Planificador (${model})` } },
    {
      ...base,
      seq: 1,
      ts: ts(),
      type: 'usage',
      payload: { inputTokens: u.input_tokens + cacheRead + cacheWrite, outputTokens: u.output_tokens, cachedInputTokens: cacheRead, cacheWriteTokens: cacheWrite, costUsd, model },
    },
    { ...base, seq: 2, ts: ts(), type: 'done', payload: { ok: res.stop_reason !== 'refusal', summary: `stop_reason: ${res.stop_reason ?? 'desconocido'}` } },
  ];
  try {
    for (const e of events) opts.sink.append(e);
  } catch (err) {
    opts.log?.(redactSecrets(`planificador: no se pudo registrar el consumo: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** `Planner` de la API local sobre `planToTasks`. */
export function createPlanner(llm: PlannerLlm, opts: { maxRepairs?: number } = {}): Planner {
  return {
    async plan({ projectId, text, knownTaskIds, signal }) {
      const r = await planToTasks(text, llm, {
        projectId,
        knownTaskIds,
        ...(opts.maxRepairs !== undefined ? { maxRepairs: opts.maxRepairs } : {}),
        ...(signal ? { signal } : {}),
      });
      return r.ok ? { ok: true, tasks: r.tasks, attempts: r.attempts } : { ok: false, issues: r.issues, attempts: r.attempts };
    },
  };
}

/** Agente Claude con clave para planificar: el indicado o el primer `claude-sdk` habilitado (si no, una `api` de Anthropic). */
export function pickPlannerAgent(agents: readonly AgentRecord[], agentId?: string): AgentRecord | undefined {
  const usable = agents.filter((a) => a.config.enabled && a.config.provider === 'anthropic' && a.config.secretRef);
  if (agentId) return usable.find((a) => a.config.id === agentId);
  return usable.find((a) => a.config.kind === 'claude-sdk') ?? usable[0];
}

/** Lee el agente y su clave de la bóveda en cada llamada. Sin agente responde 501 en la API local. */
export function plannerCredentialsFrom(
  agents: { listAgents(): AgentRecord[] },
  vault: Pick<SecretVault, 'get'>,
  agentId?: string,
): () => Promise<PlannerCredentials> {
  return async () => {
    const agent = pickPlannerAgent(agents.listAgents(), agentId);
    if (!agent?.config.secretRef) {
      throw new ApiError(501, 'not_configured', 'No hay un agente Claude con clave: agrégalo con POST /agents o «node src/core/app/cli.ts agregar-claude»');
    }
    const apiKey = await vault.get(agent.config.secretRef);
    if (!apiKey) throw new ApiError(501, 'not_configured', `Falta la clave del agente ${agent.config.id} en la bóveda`);
    return { config: agent.config, apiKey };
  };
}
