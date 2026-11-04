import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '../../../shared/contracts.ts';
import type { AgentConfig, AgentEvent, ErrorCode, ProbeResult, QuotaMethod, RunContext, TaskBrief, Usage } from '../../../shared/index.ts';
import { probeResultSchema, redactSecrets } from '../../../shared/index.ts';
import { renderBrief } from '../../brief/render-brief.ts';
import { hasRateLimitHeaders, type ResponseHeadersQuota } from '../../quota/response-headers.ts';
import { checkOpenRouterKey, listGoogleModels, listOpenAiStyleModels, streamAiSdk } from './ai-sdk.ts';
import { listAnthropicModels, streamAnthropic } from './anthropic.ts';
import { classifyApiError, type ClassifiedError } from './errors.ts';
import { EventFactory, RedactingTextBuffer } from './events.ts';
import { trackingFetch, type FetchFn } from './http.ts';
import {
  API_KEY_ENV,
  PROVIDERS,
  apiKeyFromEnv,
  insecureUrlWarning,
  isApiProvider,
  isInsecureUrl,
  resolveBaseUrl,
  type ApiProvider,
} from './providers.ts';
import type { ModelListRequest, StreamChunk, StreamRequest } from './types.ts';

export interface ApiAdapterOptions {
  /** `kind: 'api'` y un proveedor de chat por API. Nunca trae la clave. */
  config: AgentConfig;
  /**
   * Clave fuera de una ejecución (`probe`) y respaldo si `ctx.env` no la trae. Normalmente lee la bóveda.
   * En `run` manda `ctx.env.ORQ_API_KEY` (o el nombre propio del proveedor, p. ej. `ANTHROPIC_API_KEY`).
   */
  getApiKey?: () => string | undefined | Promise<string | undefined>;
  /** `fetch` inyectable (pruebas, proxy). Por defecto el global. */
  fetch?: FetchFn;
  /** Recibe las cabeceras de límite de cada respuesta del proveedor (cupo `response-headers`). */
  headersQuota?: Pick<ResponseHeadersQuota, 'update'>;
  /** Tope de tokens de salida. Anthropic lo exige (16 000 por defecto); en los demás, el del modelo. */
  maxOutputTokens?: number;
  /** Reintentos del SDK ante 408/409/429/5xx y errores de red (por defecto 2). Un 429 que persiste es `quota_exhausted`. */
  maxRetries?: number;
  /** Plazo de `probe` (por defecto 15 s). */
  probeTimeoutMs?: number;
  /** Costo en USD para el presupuesto manual; sin él, `usage.costUsd` queda vacío. */
  estimateCostUsd?: (usage: Usage, provider: ApiProvider) => number | undefined;
  now?: () => Date;
  newSessionId?: () => string;
}

const SUMMARY_CHARS = 1000;

/**
 * Adaptador de chat por API, sin herramientas (llegan en F6): Anthropic con `@anthropic-ai/sdk`; OpenAI, Google,
 * OpenRouter y compatibles con el AI SDK. Emite `status` → `text`… → `usage` → `done`, o `error` + `done`.
 */
export class ApiChatAdapter implements AgentAdapter {
  readonly config: AgentConfig;
  readonly provider: ApiProvider;
  readonly #opts: ApiAdapterOptions;
  readonly #fetch: FetchFn;
  #sawLimitHeaders = false;

  constructor(opts: ApiAdapterOptions) {
    const { config } = opts;
    if (config.kind !== 'api') throw new Error(`ApiChatAdapter requiere kind 'api' (recibió '${config.kind}').`);
    if (!isApiProvider(config.provider)) throw new Error(`Proveedor no admitido por el adaptador de API: '${config.provider}'.`);
    this.config = config;
    this.provider = config.provider;
    this.#opts = opts;
    this.#fetch = trackingFetch(opts.fetch ?? globalThis.fetch, (headers) => {
      if (!hasRateLimitHeaders(headers)) return;
      this.#sawLimitHeaders = true;
      this.#opts.headersQuota?.update(headers);
    });
  }

  /** Método de cupo detectado: OpenRouter por su `/key`; cabeceras si alguna respuesta las trajo; si no, presupuesto manual. */
  get quotaMethod(): QuotaMethod {
    if (this.provider === 'openrouter') return 'openrouter-key';
    return this.#sawLimitHeaders ? 'response-headers' : 'manual-budget';
  }

  async probe(): Promise<ProbeResult> {
    const info = PROVIDERS[this.provider];
    const warnings: string[] = [];
    const apiKey = await this.#readInjectedKey(warnings);
    const baseUrl = resolveBaseUrl(this.provider, this.config.baseUrl);
    let models: string[] = [];
    let authenticated = false;

    if (!baseUrl) {
      warnings.push(`Falta la URL base (baseUrl): ${info.label} no tiene una por defecto.`);
    } else {
      if (isInsecureUrl(baseUrl)) warnings.push(insecureUrlWarning(baseUrl));
      if (!apiKey && info.keyRequired) {
        warnings.push(`Falta la clave de API de ${info.label}.`);
      } else {
        const req: ModelListRequest = {
          apiKey,
          baseUrl,
          fetch: this.#fetch,
          signal: AbortSignal.timeout(this.#opts.probeTimeoutMs ?? 15_000),
        };
        try {
          models = [...new Set(await this.#listModels(req))];
          authenticated = true;
        } catch (err) {
          warnings.push(probeWarning(classifyApiError(err), 'No se pudieron listar los modelos'));
        }
        if (this.provider === 'openrouter' && apiKey) {
          // `/models` de OpenRouter es público: la clave se valida aparte con `/key`.
          try {
            await checkOpenRouterKey(req);
            authenticated = true;
          } catch (err) {
            authenticated = false;
            warnings.push(probeWarning(classifyApiError(err), 'No se pudo comprobar la clave con /key'));
          }
        }
      }
    }

    const model = this.config.model;
    if (model && models.length > 0 && !models.includes(model)) {
      warnings.push(`El modelo configurado (${model}) no aparece en la lista del proveedor.`);
    }
    if (this.quotaMethod === 'manual-budget' && this.config.budgetUsd === undefined) {
      warnings.push('El proveedor no envió cabeceras de límite: el cupo será un presupuesto manual; define budgetUsd.');
    }
    const secrets = apiKey ? [apiKey] : [];
    return probeResultSchema.parse({
      agentId: this.config.id,
      installed: true,
      authenticated,
      models,
      quotaMethod: this.quotaMethod,
      warnings: warnings.map((w) => redactSecrets(w, secrets)),
    });
  }

  async *run(task: TaskBrief, ctx: RunContext): AsyncGenerator<AgentEvent> {
    const info = PROVIDERS[this.provider];
    const apiKey = apiKeyFromEnv(this.provider, ctx.env) ?? (await this.#readInjectedKey([]));
    const secrets = [...new Set([...(apiKey ? [apiKey] : []), ...Object.values(ctx.env)])];
    const ev = new EventFactory({
      sessionId: (this.#opts.newSessionId ?? randomUUID)(),
      agentId: this.config.id,
      now: this.#opts.now ?? (() => new Date()),
      secrets,
    });
    const baseUrl = resolveBaseUrl(this.provider, this.config.baseUrl);
    const model = this.config.model ?? info.defaultModel;
    const detail = [info.label, model ?? '(sin modelo)'];
    if (baseUrl && isInsecureUrl(baseUrl)) detail.push(insecureUrlWarning(baseUrl));
    yield ev.status('starting', detail.join(' · '));

    const fail = (code: ErrorCode, message: string): AgentEvent[] => [ev.error(code, message), ev.done(false, message)];
    if (!baseUrl) return yield* fail('unknown', `Falta la URL base (baseUrl) de ${info.label}.`);
    if (!model) return yield* fail('unknown', `Falta el modelo (config.model) de ${info.label}.`);
    if (!apiKey && info.keyRequired) return yield* fail('auth', `Falta la clave de API de ${info.label} (${API_KEY_ENV} en ctx.env).`);
    if (ctx.signal.aborted) return yield* fail('cancelled', 'Tarea cancelada antes de empezar.');

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer =
      ctx.timeoutMs > 0 && ctx.timeoutMs <= 2_147_483_647
        ? setTimeout(() => {
            timedOut = true;
            controller.abort(new DOMException(`Plazo de ${ctx.timeoutMs} ms superado`, 'TimeoutError'));
          }, ctx.timeoutMs)
        : undefined;

    let finished = false;
    let text = '';
    const buffers = { assistant: new RedactingTextBuffer(secrets), 'thinking-summary': new RedactingTextBuffer(secrets) };
    // Texto retenido por el búfer de tachado: sale antes del uso, del error o del final.
    const flushText = (): AgentEvent[] =>
      (['thinking-summary', 'assistant'] as const).flatMap((role) => {
        const rest = buffers[role].flush();
        return rest ? [ev.text(rest, role)] : [];
      });
    try {
      const request: StreamRequest = {
        model,
        prompt: renderBrief(task, ctx.handoff),
        apiKey,
        baseUrl,
        fetch: this.#fetch,
        signal: controller.signal,
        maxRetries: this.#opts.maxRetries ?? 2,
        maxOutputTokens: this.#opts.maxOutputTokens,
      };
      yield ev.status('running');
      for await (const chunk of this.#stream(request)) {
        if (chunk.type === 'text') {
          if (chunk.role === 'assistant') text += chunk.text;
          const ready = buffers[chunk.role].push(chunk.text);
          if (ready) yield ev.text(ready, chunk.role);
          continue;
        }
        finished = true;
        yield* flushText();
        yield ev.usage(this.#withCost(chunk.usage));
        const ok = chunk.finishReason !== 'content-filter' && chunk.finishReason !== 'error';
        // Se tacha antes de recortar: un corte a mitad de una clave dejaría pasar su comienzo.
        yield ev.done(ok, summarize(redactSecrets(text, secrets), chunk));
        return;
      }
      // La transmisión terminó sin mensaje final: aborto silencioso o respuesta cortada.
      finished = true;
      const failure: ClassifiedError =
        timedOut || ctx.signal.aborted
          ? this.#failure(undefined, ctx, timedOut)
          : { code: 'invalid_output', message: 'La transmisión terminó sin mensaje final.' };
      yield* flushText();
      yield ev.error(failure.code, failure.message);
      yield ev.done(false, failure.message);
    } catch (err) {
      const failure = this.#failure(err, ctx, timedOut);
      yield* flushText();
      yield ev.error(failure.code, failure.message);
      yield ev.done(false, failure.message);
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      // Si quien consume deja de iterar antes del final, se corta la conexión.
      if (!finished && !controller.signal.aborted) controller.abort();
    }
  }

  #failure(err: unknown, ctx: RunContext, timedOut: boolean): ClassifiedError {
    if (timedOut) return { code: 'timeout', message: `Se superó el plazo de la tarea (${ctx.timeoutMs} ms).` };
    if (ctx.signal.aborted) return { code: 'cancelled', message: 'Tarea cancelada por el orquestador.' };
    return classifyApiError(err);
  }

  #stream(req: StreamRequest): AsyncIterable<StreamChunk> {
    return this.provider === 'anthropic' ? streamAnthropic(req) : streamAiSdk(this.provider, req);
  }

  #listModels(req: ModelListRequest): Promise<string[]> {
    if (this.provider === 'anthropic') return listAnthropicModels(req);
    if (this.provider === 'google') return listGoogleModels(req);
    return listOpenAiStyleModels(req);
  }

  async #readInjectedKey(warnings: string[]): Promise<string | undefined> {
    if (!this.#opts.getApiKey) return undefined;
    try {
      return (await this.#opts.getApiKey())?.trim() || undefined;
    } catch {
      warnings.push('No se pudo leer la clave de la bóveda.');
      return undefined;
    }
  }

  #withCost(usage: Usage): Usage {
    const cost = this.#opts.estimateCostUsd?.(usage, this.provider);
    if (cost === undefined || !Number.isFinite(cost) || cost < 0) return usage;
    return { ...usage, costUsd: Math.round(cost * 1e6) / 1e6 };
  }
}

function probeWarning(err: ClassifiedError, context: string): string {
  if (err.code === 'auth') return `El proveedor rechazó la clave${err.status ? ` (HTTP ${err.status})` : ''}.`;
  if (err.code === 'quota_exhausted') return `${context}: cupo o saldo agotado. ${err.message}`;
  return `${context}: ${err.message}`;
}

function summarize(text: string, finish: StreamChunk & { type: 'finish' }): string {
  const trimmed = text.trim();
  const body = trimmed.length > SUMMARY_CHARS ? `${trimmed.slice(0, SUMMARY_CHARS)}…` : trimmed;
  const raw = finish.rawFinishReason ? ` (${finish.rawFinishReason})` : '';
  if (finish.finishReason === 'content-filter') return `El proveedor bloqueó o rechazó la respuesta${raw}. ${body}`.trim();
  if (finish.finishReason === 'error') return `El proveedor terminó con error${raw}. ${body}`.trim();
  if (finish.finishReason === 'length') return `${body} [respuesta truncada por el límite de tokens${raw}]`.trim();
  return body || '(respuesta vacía)';
}
