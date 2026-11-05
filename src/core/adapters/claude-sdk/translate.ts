import { isAbsolute, relative, resolve } from 'node:path';
import type { z } from 'zod';
import type { AgentEvent, ErrorCode } from '../../../shared/index.ts';
import { redactSecrets } from '../../../shared/index.ts';
import { classifyClaudeError } from './errors.ts';
import { estimateCostUsd, type TokenUsage } from './pricing.ts';
import {
  anyMessageSchema,
  apiRetrySchema,
  assistantMessageSchema,
  authStatusSchema,
  initMessageSchema,
  rateLimitEventSchema,
  resultMessageSchema,
  systemMessageSchema,
  taskNotificationSchema,
  taskProgressSchema,
  taskStartedSchema,
  taskUpdatedSchema,
  textBlockSchema,
  thinkingBlockSchema,
  toolResultBlockSchema,
  toolUseBlockSchema,
  userMessageSchema,
  type ModelUsageInfo,
  type ResultMessage,
} from './schemas.ts';

/**
 * Traduce los mensajes del SDK de agentes de Claude a `AgentEvent`.
 *
 * Árbol de subagentes: cada mensaje con `parent_tool_use_id` pertenece al subagente que lanzó esa
 * llamada a herramienta (`Agent`/`Task`). Su `sessionId` es ese id de llamada y su `parentSessionId`
 * es la sesión que emitió la llamada (la principal o, si hay anidamiento, otro subagente).
 * Los mensajes `system` `task_*` actualizan el `status` del subagente.
 */

export const SUMMARY_MAX = 300;
const DONE_SUMMARY_MAX = 2000;

/** Vida de la caché de prompts: tras una pausa más larga, la llamada siguiente vuelve a escribir todo el prompt. */
export const CACHE_TTL_MS = 5 * 60_000;
/**
 * El `usage` que trae cada mensaje del asistente es el de `message_start`. Tras el servidor intermedio del usuario
 * llega sin repartir la caché (`cache_*` en 0, todo en `input_tokens`, `output_tokens: 1`) y se queda corto: en las
 * dos ejecuciones grabadas (`hook-deny.jsonl`, `subagent-run.jsonl`) la entrada real del resultado fue 1,41 y 1,43
 * veces la suma de esos `input_tokens`. Contarlo como entrada sin caché inflaba el costo de una sesión cortada
 * (14,55 USD registrados el 2026-11-04 por 3,64 M «sin caché» y 32 tokens de salida, uno por llamada).
 */
export const UNSPLIT_INPUT_FACTOR = 1.4;
/** Caracteres por token para estimar la salida a partir de lo visible (texto, pensamiento resumido y argumentos). */
export const CHARS_PER_OUTPUT_TOKEN = 3.5;

type EventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;
type State = EventOf<'status'>['payload']['state'];

export interface TranslatorOptions {
  agentId: string;
  /** Id de la sesión principal (propio del orquestador; el del SDK se guarda en `sdkSessionId`). */
  sessionId: string;
  now?: () => Date;
  /** Valores que se tachan además de los patrones de `redactSecrets` (p. ej. la clave en uso). */
  secrets?: readonly string[];
  /** Carpeta de trabajo: las rutas de `file_change` se informan relativas a ella. */
  cwd?: string;
}

/** Recorta y aplana espacios para paneles: como mucho `max` caracteres. */
export function truncate(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Resumen legible de la entrada de una herramienta (sin tachar ni recortar). */
export function describeToolInput(name: string, input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const i = input as Record<string, unknown>;
    if (name === 'Agent' || name === 'Task') {
      const kind = str(i.subagent_type) ?? 'general-purpose';
      const what = str(i.description) ?? str(i.prompt) ?? '';
      return `${kind}: ${what}`;
    }
    const salient = str(i.command) ?? str(i.file_path) ?? str(i.notebook_path) ?? str(i.url) ?? str(i.query) ?? str(i.pattern);
    if (salient) {
      const where = str(i.path);
      return where && salient === i.pattern ? `${salient} en ${where}` : salient;
    }
  }
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
}

/** Texto de un `tool_result.content` (cadena o bloques). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const text = textBlockSchema.safeParse(block);
        if (text.success) return text.data.text;
        const typed = anyMessageSchema.safeParse(block);
        return typed.success ? `[${typed.data.type}]` : '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const TASK_STATUS: Readonly<Record<string, State>> = {
  pending: 'starting',
  running: 'running',
  paused: 'waiting',
  completed: 'done',
  failed: 'failed',
  killed: 'cancelled',
  stopped: 'cancelled',
};

/** Pista de error vista durante la ejecución (se usa si el resultado final falla). */
export interface ErrorHint {
  code: ErrorCode;
  message: string;
}

export class ClaudeSdkTranslator {
  readonly agentId: string;
  readonly sessionId: string;
  /** `session_id` del SDK (permite reanudar la sesión). */
  sdkSessionId: string | undefined;
  /** Costo acumulado conocido en USD (de `usage_report` o del resultado). */
  costUsd = 0;
  /** Uso por modelo más reciente conocido (de `usage_report` o del resultado). */
  modelUsage: Record<string, ModelUsageInfo> = {};
  /** True cuando llegó el mensaje `result` (ya se emitió `done`). */
  finished = false;
  result: ResultMessage | undefined;
  hint: ErrorHint | undefined;
  /**
   * Error que no se arregla reintentando (401/403 o sin saldo): el SDK reintenta hasta 10 veces
   * (~3 min con una clave inválida), así que el adaptador corta al verlo.
   */
  fatal: ErrorHint | undefined;

  readonly #now: () => Date;
  readonly #secrets: readonly string[];
  readonly #cwd: string | undefined;
  #seq = 0;
  /** tool_use_id → sesión que emitió la llamada. */
  readonly #toolOwner = new Map<string, string>();
  /** tool_use_id → archivo, para llamadas que editan archivos. */
  readonly #pendingFiles = new Map<string, { tool: string; path: string }>();
  /** task_id → sesión del subagente. */
  readonly #taskSession = new Map<string, string>();
  readonly #announced = new Set<string>();
  /**
   * id de mensaje de la API → modelo, uso (máximo visto), hilo (sesión principal o subagente), hora de llegada y
   * caracteres de su contenido, para estimar el costo en curso. En orden de llegada.
   */
  readonly #perMessage = new Map<string, TrackedMessage>();

  constructor(opts: TranslatorOptions) {
    this.agentId = opts.agentId;
    this.sessionId = opts.sessionId;
    this.#now = opts.now ?? (() => new Date());
    this.#secrets = opts.secrets ?? [];
    this.#cwd = opts.cwd;
  }

  redact(text: string): string {
    return redactSecrets(text, this.#secrets);
  }

  /** Todos los eventos salen por aquí: cada campo de texto de la carga se tacha de forma uniforme. */
  #event<T extends AgentEvent['type']>(type: T, payload: EventOf<T>['payload'], sessionId = this.sessionId, parentSessionId?: string): AgentEvent {
    const clean = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === 'string' ? this.redact(v) : v]));
    const event = { sessionId, agentId: this.agentId, seq: this.#seq++, ts: this.#now().toISOString(), type, payload: clean } as AgentEvent;
    if (parentSessionId !== undefined) event.parentSessionId = parentSessionId;
    return event;
  }

  status(state: State, detail?: string): AgentEvent {
    return this.#event('status', detail === undefined ? { state } : { state, detail: this.redact(detail) });
  }

  error(code: ErrorCode, message: string): AgentEvent {
    return this.#event('error', { code, message: truncate(this.redact(message), DONE_SUMMARY_MAX) });
  }

  done(ok: boolean, summary?: string): AgentEvent {
    return this.#event('done', summary === undefined ? { ok } : { ok, summary: truncate(this.redact(summary), DONE_SUMMARY_MAX) });
  }

  /** Eventos `usage` (uno por modelo) a partir del uso conocido hasta ahora. */
  usageEvents(modelUsage: Record<string, ModelUsageInfo> = this.modelUsage): AgentEvent[] {
    return Object.entries(modelUsage).map(([model, u]) => {
      const cached = Math.round(u.cacheReadInputTokens ?? 0);
      const payload: EventOf<'usage'>['payload'] = {
        // Entrada total procesada (incluye lo leído de caché y lo escrito en ella); `cachedInputTokens` y
        // `cacheWriteTokens` son las partes leída y escrita.
        inputTokens: Math.round(u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)),
        outputTokens: Math.round(u.outputTokens),
        cachedInputTokens: cached,
        cacheWriteTokens: Math.round(u.cacheCreationInputTokens ?? 0),
        model,
      };
      if (u.thinkingTokens !== undefined) payload.reasoningTokens = Math.round(u.thinkingTokens);
      if (u.costUSD !== undefined) payload.costUsd = u.costUSD;
      return this.#event('usage', payload);
    });
  }

  /** Costo estimado con precios públicos a partir del `usage` de cada mensaje (ver pricing.ts y `#estimate`). */
  get estimatedCostUsd(): number {
    let total = 0;
    for (const { cost } of this.#estimate().values()) total += cost;
    return total;
  }

  /** Gasto en curso para el tope de presupuesto: lo informado por el SDK o la estimación, lo que sea mayor. */
  get spentUsd(): number {
    return Math.max(this.costUsd, this.estimatedCostUsd);
  }

  /**
   * Uso para registrar si la ejecución termina sin `result` (cancelada, tiempo agotado, tope):
   * el último desglose del SDK si lo hubo; si no, la estimación por modelo.
   */
  partialUsageEvents(): AgentEvent[] {
    if (Object.keys(this.modelUsage).length > 0) return this.usageEvents();
    return [...this.#estimate()].map(([model, u]) =>
      this.#event('usage', {
        inputTokens: Math.round(u.input + u.cacheRead + u.cacheWrite),
        outputTokens: Math.round(u.output),
        cachedInputTokens: Math.round(u.cacheRead),
        cacheWriteTokens: Math.round(u.cacheWrite),
        costUsd: Math.round(u.cost * 1e6) / 1e6,
        model,
      }),
    );
  }

  /**
   * Uso estimado por modelo. Un mensaje que trae la caché repartida (`cache_*` > 0, la API directa) se cuenta tal
   * cual. Uno sin repartir (servidor intermedio) se reparte como lo hace Claude Code con la caché de prompts: dentro
   * de cada hilo, el prompt de la llamada anterior se lee de caché si pasaron ≤ 5 min, y el resto se escribe; la
   * primera llamada del hilo escribe todo. La salida es la mayor entre la informada y la que se deduce del contenido.
   */
  #estimate(): Map<string, TokenUsage & { cost: number }> {
    const byModel = new Map<string, TokenUsage & { cost: number }>();
    const lastPrompt = new Map<string, { tokens: number; at: number }>();
    for (const m of this.#perMessage.values()) {
      const u = m.usage;
      const output = Math.max(u.output, Math.ceil(m.chars / CHARS_PER_OUTPUT_TOKEN));
      let usage: TokenUsage;
      if (u.cacheRead > 0 || u.cacheWrite > 0 || u.input === 0) {
        usage = { ...u, output };
      } else {
        const prompt = Math.round(u.input * UNSPLIT_INPUT_FACTOR);
        const prev = lastPrompt.get(m.thread);
        const cacheRead = prev && m.at - prev.at <= CACHE_TTL_MS ? Math.min(prev.tokens, prompt) : 0;
        usage = { input: 0, output, cacheRead, cacheWrite: prompt - cacheRead };
        lastPrompt.set(m.thread, { tokens: prompt, at: m.at });
      }
      const key = m.model ?? 'desconocido';
      const acc = byModel.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      acc.input += usage.input;
      acc.output += usage.output;
      acc.cacheRead += usage.cacheRead;
      acc.cacheWrite += usage.cacheWrite;
      acc.cost += estimateCostUsd(m.model, usage);
      byModel.set(key, acc);
    }
    return byModel;
  }

  #trackUsage(
    id: string | undefined,
    model: string | undefined,
    usage: z.infer<typeof assistantMessageSchema>['message']['usage'],
    seen: { thread: string; chars: number },
  ): void {
    if (!usage) return;
    const key = id ?? `sin-id-${this.#perMessage.size}`;
    const prev = this.#perMessage.get(key);
    const was = prev?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // Varios mensajes con el mismo id son bloques de una misma llamada: el uso se toma por máximo y el contenido se suma.
    this.#perMessage.set(key, {
      model,
      thread: prev?.thread ?? seen.thread,
      at: prev?.at ?? this.#now().getTime(),
      chars: (prev?.chars ?? 0) + seen.chars,
      usage: {
        input: Math.max(was.input, usage.input_tokens ?? 0),
        output: Math.max(was.output, usage.output_tokens ?? 0),
        cacheRead: Math.max(was.cacheRead, usage.cache_read_input_tokens ?? 0),
        cacheWrite: Math.max(was.cacheWrite, usage.cache_creation_input_tokens ?? 0),
      },
    });
  }

  /** Sesión padre de una sesión: la que emitió la llamada que lanzó el subagente. */
  #parentOf(sessionId: string): string | undefined {
    return sessionId === this.sessionId ? undefined : (this.#toolOwner.get(sessionId) ?? this.sessionId);
  }

  /** Sesión de un mensaje según su `parent_tool_use_id`; anuncia el subagente la primera vez. */
  #sessionFor(parentToolUseId: string | null | undefined, out: AgentEvent[], detail?: string): { sessionId: string; parent?: string } {
    if (!parentToolUseId) return { sessionId: this.sessionId };
    const parent = this.#parentOf(parentToolUseId);
    if (!this.#announced.has(parentToolUseId)) {
      this.#announced.add(parentToolUseId);
      out.push(this.#event('status', { state: 'running', detail: this.redact(detail ?? 'subagente') }, parentToolUseId, parent));
    }
    return { sessionId: parentToolUseId, parent };
  }

  #taskSessionFor(taskId: string, toolUseId: string | undefined): { sessionId: string; parent: string | undefined } {
    const sessionId = toolUseId ?? this.#taskSession.get(taskId) ?? `task-${taskId}`;
    this.#taskSession.set(taskId, sessionId);
    return { sessionId, parent: this.#parentOf(sessionId) };
  }

  #subagentStatus(taskId: string, toolUseId: string | undefined, state: State, detail: string): AgentEvent {
    const { sessionId, parent } = this.#taskSessionFor(taskId, toolUseId);
    this.#announced.add(sessionId);
    return this.#event('status', { state, detail: truncate(this.redact(detail)) }, sessionId, parent);
  }

  #relativePath(file: string): string {
    if (!this.#cwd) return file.replace(/\\/g, '/');
    const abs = isAbsolute(file) ? file : resolve(this.#cwd, file);
    const rel = relative(this.#cwd, abs);
    const inside = rel && !rel.startsWith('..') && !isAbsolute(rel);
    return (inside ? rel : abs).replace(/\\/g, '/');
  }

  #raw(source: string, value: unknown): AgentEvent {
    let line: string;
    try {
      line = JSON.stringify(value) ?? String(value);
    } catch {
      line = String(value);
    }
    return this.#event('raw', { source, line: truncate(this.redact(line), DONE_SUMMARY_MAX) });
  }

  /** Traduce un mensaje del SDK. Nunca lanza: lo que no reconoce sale como `raw`. */
  translate(message: unknown): AgentEvent[] {
    const typed = anyMessageSchema.safeParse(message);
    if (!typed.success) return [this.#raw('claude-sdk', message)];
    switch (typed.data.type) {
      case 'assistant':
        return this.#assistant(message);
      case 'user':
        return this.#user(message);
      case 'system':
        return this.#system(message);
      case 'result':
        return this.#result(message);
      case 'auth_status': {
        const parsed = authStatusSchema.safeParse(message);
        if (parsed.success && parsed.data.error) this.hint = { code: 'auth', message: parsed.data.error };
        return parsed.success ? [] : [this.#raw('claude-sdk:auth_status', message)];
      }
      case 'rate_limit_event': {
        const parsed = rateLimitEventSchema.safeParse(message);
        if (!parsed.success) return [this.#raw('claude-sdk:rate_limit_event', message)];
        if (parsed.data.rate_limit_info.status === 'rejected') {
          this.hint = { code: 'quota_exhausted', message: 'El proveedor rechazó la solicitud por límite de uso.' };
          return [this.status('waiting', 'límite de uso alcanzado')];
        }
        return [];
      }
      // Latidos y avisos internos sin valor para los paneles.
      case 'tool_progress':
      case 'tool_use_summary':
      case 'stream_event':
      case 'prompt_suggestion':
        return [];
      default:
        return [this.#raw(`claude-sdk:${typed.data.type}`, message)];
    }
  }

  #assistant(message: unknown): AgentEvent[] {
    const parsed = assistantMessageSchema.safeParse(message);
    if (!parsed.success) return [this.#raw('claude-sdk:assistant', message)];
    const msg = parsed.data;
    const out: AgentEvent[] = [];
    if (!this.sdkSessionId && msg.session_id) this.sdkSessionId = msg.session_id;
    if (msg.usage_report) {
      this.costUsd = Math.max(this.costUsd, msg.usage_report.session.total_cost_usd);
      if (msg.usage_report.session.model_usage) this.modelUsage = msg.usage_report.session.model_usage;
    }
    const { sessionId, parent } = this.#sessionFor(msg.parent_tool_use_id, out);
    if (!msg.is_api_error_message) this.#trackUsage(msg.message.id, msg.message.model, msg.message.usage, { thread: sessionId, chars: contentChars(msg.message.content) });
    if (msg.error) {
      const code = classifyClaudeError({ httpStatus: msg.api_error_status, assistantError: msg.error }, 'unknown');
      if (code !== 'unknown') this.hint = { code, message: `El SDK informó ${msg.error}${msg.api_error_status ? ` (HTTP ${msg.api_error_status})` : ''}.` };
    }
    // El texto de un error de la API llega como mensaje sintético; se informa como `error` al final.
    if (msg.is_api_error_message) return out;
    for (const block of msg.message.content) {
      const text = textBlockSchema.safeParse(block);
      if (text.success) {
        if (text.data.text.trim()) out.push(this.#event('text', { text: this.redact(text.data.text), role: 'assistant' }, sessionId, parent));
        continue;
      }
      const thinking = thinkingBlockSchema.safeParse(block);
      if (thinking.success) {
        if (thinking.data.thinking.trim()) {
          out.push(this.#event('text', { text: this.redact(thinking.data.thinking), role: 'thinking-summary' }, sessionId, parent));
        }
        continue;
      }
      const tool = toolUseBlockSchema.safeParse(block);
      if (tool.success) {
        const { id, name, input } = tool.data;
        this.#toolOwner.set(id, sessionId);
        if (FILE_TOOLS.has(name) && input && typeof input === 'object') {
          const i = input as Record<string, unknown>;
          const path = str(i.file_path) ?? str(i.notebook_path);
          if (path) this.#pendingFiles.set(id, { tool: name, path });
        }
        out.push(
          this.#event('tool_call', { callId: id, name, inputSummary: truncate(this.redact(describeToolInput(name, input))) }, sessionId, parent),
        );
        continue;
      }
      // redacted_thinking, bloques de resultado de herramientas del servidor y otros: sin evento.
    }
    return out;
  }

  #user(message: unknown): AgentEvent[] {
    const parsed = userMessageSchema.safeParse(message);
    if (!parsed.success) return [this.#raw('claude-sdk:user', message)];
    const msg = parsed.data;
    if (typeof msg.message.content === 'string') return []; // eco del encargo o del prompt de un subagente
    const out: AgentEvent[] = [];
    const { sessionId, parent } = this.#sessionFor(msg.parent_tool_use_id, out);
    const results = msg.message.content.map((b) => toolResultBlockSchema.safeParse(b)).filter((r) => r.success).map((r) => r.data);
    // `tool_use_result` (resultado estructurado) trae el informe limpio de un subagente, sin el marco del arnés.
    const structured = results.length === 1 ? structuredContent(msg.tool_use_result) : undefined;
    for (const result of results) {
      const { tool_use_id: callId, is_error: isError } = result;
      const content = structured ?? result.content;
      const ok = isError !== true;
      // El resultado va a la sesión que hizo la llamada (la del mensaje, salvo casos raros).
      const target = this.#toolOwner.get(callId) ?? sessionId;
      const targetParent = target === sessionId ? parent : this.#parentOf(target);
      out.push(this.#event('tool_result', { callId, ok, summary: truncate(this.redact(toolResultText(content))) }, target, targetParent));
      const file = this.#pendingFiles.get(callId);
      if (file) {
        this.#pendingFiles.delete(callId);
        if (ok) {
          const created = file.tool === 'Write' && isCreate(msg.tool_use_result);
          out.push(this.#event('file_change', { path: this.#relativePath(file.path), change: created ? 'add' : 'modify' }, target, targetParent));
        }
      }
    }
    return out;
  }

  #system(message: unknown): AgentEvent[] {
    const base = systemMessageSchema.safeParse(message);
    if (!base.success) return [this.#raw('claude-sdk:system', message)];
    switch (base.data.subtype) {
      case 'init': {
        const init = initMessageSchema.safeParse(message);
        if (!init.success) return [this.#raw('claude-sdk:system/init', message)];
        this.sdkSessionId = init.data.session_id;
        const parts = [`modelo ${init.data.model}`];
        if (init.data.claude_code_version) parts.push(`Claude Code ${init.data.claude_code_version}`);
        if (init.data.permissionMode) parts.push(`permisos ${init.data.permissionMode}`);
        return [this.status('running', parts.join(' · '))];
      }
      case 'task_started': {
        const t = taskStartedSchema.safeParse(message);
        if (!t.success) return [this.#raw('claude-sdk:system/task_started', message)];
        const kind = t.data.subagent_type ? `${t.data.subagent_type}: ` : '';
        return [this.#subagentStatus(t.data.task_id, t.data.tool_use_id, 'running', `${kind}${t.data.description}`)];
      }
      case 'task_progress': {
        const t = taskProgressSchema.safeParse(message);
        if (!t.success) return [this.#raw('claude-sdk:system/task_progress', message)];
        const detail = [t.data.summary ?? t.data.description];
        if (t.data.last_tool_name) detail.push(`última herramienta: ${t.data.last_tool_name}`);
        if (t.data.usage) detail.push(`${t.data.usage.total_tokens} tokens, ${t.data.usage.tool_uses} herramientas`);
        return [this.#subagentStatus(t.data.task_id, t.data.tool_use_id, 'running', detail.join(' · '))];
      }
      case 'task_updated': {
        const t = taskUpdatedSchema.safeParse(message);
        if (!t.success) return [this.#raw('claude-sdk:system/task_updated', message)];
        const { status, description, error } = t.data.patch;
        if (!status) return [];
        return [this.#subagentStatus(t.data.task_id, undefined, TASK_STATUS[status] ?? 'running', error ?? description ?? status)];
      }
      case 'task_notification': {
        const t = taskNotificationSchema.safeParse(message);
        if (!t.success) return [this.#raw('claude-sdk:system/task_notification', message)];
        const detail = [t.data.summary];
        if (t.data.usage) detail.push(`${t.data.usage.total_tokens} tokens, ${t.data.usage.tool_uses} herramientas, ${Math.round(t.data.usage.duration_ms / 1000)} s`);
        return [this.#subagentStatus(t.data.task_id, t.data.tool_use_id, TASK_STATUS[t.data.status] ?? 'done', detail.join(' · '))];
      }
      case 'api_retry': {
        const r = apiRetrySchema.safeParse(message);
        if (!r.success) return [this.#raw('claude-sdk:system/api_retry', message)];
        const status = r.data.error_status === null ? r.data.error : `HTTP ${r.data.error_status}`;
        const code = classifyClaudeError({ httpStatus: r.data.error_status, assistantError: r.data.error }, 'unknown');
        if (code !== 'unknown') this.hint = { code, message: `La API respondió ${status} (${r.data.error}).` };
        // 401/403 y falta de saldo no se arreglan reintentando; un 429 sí puede pasar.
        const permanent = code === 'auth' || r.data.error_status === 402 || r.data.error === 'billing_error';
        if (permanent && this.hint) this.fatal = this.hint;
        return [this.status('waiting', `reintento ${r.data.attempt}/${r.data.max_retries} tras ${status}; espera ${Math.round(r.data.retry_delay_ms / 1000)} s`)];
      }
      // Avisos internos que no aportan a los paneles.
      case 'thinking_tokens':
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response':
      case 'session_state_changed':
      case 'commands_changed':
      case 'background_tasks_changed':
      case 'files_persisted':
        return [];
      case 'compact_boundary':
        return [this.status('running', 'contexto compactado')];
      default:
        return [this.#raw(`claude-sdk:system/${base.data.subtype}`, message)];
    }
  }

  #result(message: unknown): AgentEvent[] {
    const parsed = resultMessageSchema.safeParse(message);
    if (!parsed.success) return [this.#raw('claude-sdk:result', message)];
    const r = parsed.data;
    this.result = r;
    this.finished = true;
    if (r.session_id) this.sdkSessionId ??= r.session_id;
    this.costUsd = Math.max(this.costUsd, r.total_cost_usd);
    const out: AgentEvent[] = [];

    if (Object.keys(r.modelUsage).length > 0) {
      this.modelUsage = r.modelUsage;
      out.push(...this.usageEvents(r.modelUsage));
    } else {
      // Sin desglose por modelo: un solo evento con el total.
      const cacheRead = r.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = r.usage.cache_creation_input_tokens ?? 0;
      out.push(
        this.#event('usage', {
          inputTokens: Math.round((r.usage.input_tokens ?? 0) + cacheRead + cacheWrite),
          outputTokens: Math.round(r.usage.output_tokens ?? 0),
          cachedInputTokens: Math.round(cacheRead),
          cacheWriteTokens: Math.round(cacheWrite),
          costUsd: r.total_cost_usd,
        }),
      );
    }

    const failed = r.is_error || r.subtype !== 'success';
    if (!failed) {
      out.push(this.done(true, r.result));
      return out;
    }
    const texts = [...(r.errors ?? []), r.result ?? '', this.hint?.message ?? ''].filter(Boolean);
    const code = classifyClaudeError({ subtype: r.subtype, httpStatus: r.api_error_status, texts }, this.hint?.code ?? 'unknown');
    const reason =
      r.subtype === 'error_max_budget_usd'
        ? `Se alcanzó el tope de presupuesto del encargo (${r.total_cost_usd.toFixed(4)} USD gastados).`
        : texts[0] ?? `El SDK terminó con ${r.subtype}.`;
    const status = r.api_error_status ? ` (HTTP ${r.api_error_status})` : '';
    out.push(this.error(code, `${reason}${status}`));
    out.push(this.done(false, r.result ?? reason));
    return out;
  }
}

interface TrackedMessage {
  model: string | undefined;
  usage: TokenUsage;
  /** Sesión del mensaje: la principal o la del subagente (cada hilo tiene su propia caché de prompt). */
  thread: string;
  /** Llegada del primer bloque (ms). */
  at: number;
  /** Caracteres de texto, pensamiento y argumentos de herramientas de sus bloques. */
  chars: number;
}

/** Caracteres que escribió el modelo en los bloques de un mensaje (para estimar su salida). */
function contentChars(content: readonly unknown[]): number {
  let chars = 0;
  for (const block of content) {
    const text = textBlockSchema.safeParse(block);
    if (text.success) {
      chars += text.data.text.length;
      continue;
    }
    const thinking = thinkingBlockSchema.safeParse(block);
    if (thinking.success) {
      chars += thinking.data.thinking.length;
      continue;
    }
    const tool = toolUseBlockSchema.safeParse(block);
    if (tool.success) {
      try {
        chars += (JSON.stringify(tool.data.input) ?? '').length + tool.data.name.length;
      } catch {
        /* argumentos no serializables: no suman */
      }
    }
  }
  return chars;
}

function structuredContent(toolUseResult: unknown): unknown {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
  const content = (toolUseResult as Record<string, unknown>).content;
  return Array.isArray(content) && content.length > 0 ? content : undefined;
}

function isCreate(toolUseResult: unknown): boolean {
  return !!toolUseResult && typeof toolUseResult === 'object' && (toolUseResult as Record<string, unknown>).type === 'create';
}
