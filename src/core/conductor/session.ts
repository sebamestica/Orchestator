/**
 * Sesión de chat con el orquestador: una conversación larga con el SDK de agentes (entrada en streaming),
 * herramientas propias por MCP en proceso, solo lectura + subagentes y ninguna herramienta de edición
 * o ejecución. La función `query` se inyecta (la del SDK por defecto) para probar las opciones sin red.
 *
 * Modos de la mente (docs/plan/F5-INTERFAZ.md §2): `plan` deja `delegar` fuera de `allowedTools` y la guardia la
 * bloquea; `auto`/`bypass` aprueban solas las tareas nuevas (`autoApprove`). El modo se lee en cada llamada de la
 * guardia y de las herramientas; su texto va en el contexto dinámico del prompt (el prefijo en caché no cambia).
 */
import { randomUUID } from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition, EffortLevel, McpServerConfig, Options, SDKMessage, SDKUserMessage, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { idSchema, redactSecrets } from '../../shared/index.ts';
import type { AgentEvent, MindMode } from '../../shared/index.ts';
import { createToolGuard } from './guard.ts';
import type { Awaitable, ConductorPorts, ProposedTask, SdkMessageTranslator, TranslatorInit } from './ports.ts';
import { buildConductorSystemPrompt } from './prompt.ts';
import { redactDeep } from './redact.ts';
import { CONDUCTOR_SERVER_NAME, CONDUCTOR_TOOL_NAMES, FLEET_TOOL_NAMES, createConductorTools, mcpToolName } from './tools.ts';
import type { ConductorTools } from './tools.ts';

export const DEFAULT_CONDUCTOR_MODEL = 'claude-opus-5-5';
export const DEFAULT_CONDUCTOR_EFFORT: EffortLevel = 'high';
export const CONDUCTOR_AGENT_ID = 'orquestador';
export const CONDUCTOR_CLIENT_APP = 'orquestador/0.1.0';
/** Herramientas integradas de lectura que el orquestador puede usar. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/**
 * Herramienta de subagentes. En el SDK 0.3.302 se llama `Agent`; `Task` es su nombre anterior y sigue
 * aceptándose como alias (`LEGACY_TOOL_NAME_ALIASES.Task === 'Agent'`).
 */
export const SUBAGENT_TOOL = 'Agent';
/** Edición y ejecución: fuera del contexto del modelo aunque algún ajuste los habilitara. */
export const BLOCKED_TOOLS = [
  'Bash',
  'PowerShell',
  'Monitor',
  'Edit',
  'Write',
  'NotebookEdit',
  'EnterWorktree',
  'ExitWorktree',
  'Workflow',
  'CronCreate',
  'RemoteTrigger',
] as const;

/** Subagente propio: investiga en paralelo con las mismas herramientas de lectura. */
export const CONDUCTOR_SUBAGENTS: Readonly<Record<string, AgentDefinition>> = {
  investigador: {
    description: 'Investiga en paralelo el repositorio, la memoria, los cupos o las skills y devuelve una conclusión breve con rutas. Solo lee.',
    prompt:
      'Eres un subagente de investigación del orquestador. Solo lees: no editas archivos ni ejecutas comandos. ' +
      'Responde en español con una conclusión breve, rutas concretas y cifras exactas; no copies archivos enteros. ' +
      'Nunca repitas claves ni secretos.',
    tools: [...READ_ONLY_TOOLS, mcpToolName('estado'), mcpToolName('cupos'), mcpToolName('leer_memoria'), mcpToolName('buscar_skills')],
    model: 'inherit',
    permissionMode: 'dontAsk',
  },
};

/** Tope de una imagen en base64 que acepta la API de Mensajes (5 MB del texto codificado ≈ 3,75 MB de archivo). */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Imagen adjunta a un mensaje: va como bloque `image` (base64) del mensaje de usuario. */
export interface ImageInput {
  mediaType: ImageMediaType;
  /** Bytes en base64 (sin el prefijo `data:`). */
  data: string;
  /** Nombre para los mensajes de error. */
  name?: string;
}

export interface SendOptions {
  images?: readonly ImageInput[];
}

/** Un mensaje del SDK y los eventos que salieron de él (ya tachados). */
export interface ConductorUpdate {
  message: SDKMessage;
  events: readonly AgentEvent[];
}

/** Nombre válido de un servidor MCP extra (plugins): el SDK normaliza lo demás a `_` y rompería `allowedTools`. */
const mcpServerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((n) => n !== CONDUCTOR_SERVER_NAME, { message: `«${CONDUCTOR_SERVER_NAME}» está reservado` });

/** `query` del SDK o un doble de pruebas con la misma forma. */
export type ConductorQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & {
  close?(): void;
  interrupt?(): Promise<unknown>;
};

export interface ConductorSessionOptions {
  ports: ConductorPorts;
  /** `null`: agente suelto (sin flota: crear_tareas, delegar, estado y escribir_memoria no están disponibles). */
  projectId: string | null;
  /** Carpeta del proyecto: `cwd` del SDK y raíz de lectura. */
  cwd: string;
  /**
   * Modo de la mente. Con una función, la guardia y las herramientas la leen en cada llamada; `allowedTools` y el
   * texto del prompt salen del valor al crear la sesión (un cambio rige desde la sesión siguiente). Sin modo: terminal
   * antigua (el usuario aprueba y el orquestador delega).
   */
  mode?: MindMode | (() => MindMode);
  /** Aprobación automática de `auto`/`bypass` (ver `ConductorToolsOptions.autoApprove`). */
  autoApprove?: (taskIds: readonly string[]) => Awaitable<readonly ProposedTask[]>;
  /** Carpetas extra que eligió el usuario: se pueden leer y se nombran en el prompt. */
  extraRoots?: readonly string[];
  /** Archivos o carpetas que nunca se leen (bóveda y base de datos del núcleo). */
  denyPaths?: readonly string[];
  /** Servidores MCP extra (plugins); sus herramientas entran en `allowedTools` como `mcp__<nombre>__*`. */
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /**
   * Entorno de la sesión que sale de la bóveda (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`): se aplica sobre
   * `baseEnv`. Solo vive en memoria; las claves que trae se tachan en todas las salidas.
   */
  env?: Readonly<Record<string, string>>;
  /** Atajo de `env.ANTHROPIC_API_KEY` (gana sobre `env`). No hace falta sesión de Claude Code: basta la clave. */
  apiKey?: string;
  /** Atajo de `env.ANTHROPIC_BASE_URL` (gana sobre `env`). */
  baseUrl?: string;
  /** Ajustes de Claude Code que se cargan. Por defecto ninguno: ni sesión ni ajustes de usuario. */
  settingSources?: readonly SettingSource[];
  model?: string;
  effort?: EffortLevel;
  query?: ConductorQueryFn;
  /** Traductor de mensajes del SDK a `AgentEvent` (c1), o una fábrica que lo crea con los datos de la sesión. */
  translator?: SdkMessageTranslator | ((init: TranslatorInit) => SdkMessageTranslator);
  /** Entorno base del proceso del SDK (por defecto `process.env`). `Options.env` lo reemplaza entero. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Carpetas extra de solo lectura (p. ej. `C:\dev\agent-hub\skills`, las de los adjuntos o, en bypass, las
   * unidades). Con una función, la guardia la lee en cada llamada; `additionalDirectories` toma el valor inicial.
   */
  readRoots?: readonly string[] | (() => readonly string[]);
  /** Tope de gasto de la conversación en USD. */
  maxBudgetUsd?: number;
  maxTurns?: number;
  quotaFloor?: number;
  /** Notas del usuario para esta sesión (van al final del prompt de sistema). */
  notes?: string;
  /** Reanudar una sesión del SDK por su `session_id`. */
  resume?: string;
  sessionId?: string;
  includePartialMessages?: boolean;
  pathToClaudeCodeExecutable?: string;
  /** Salida de error del proceso del SDK, ya tachada. */
  onStderr?: (line: string) => void;
  now?: () => Date;
}

const optionsSchema = z.object({
  projectId: idSchema.nullable(),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  apiKey: z.string().min(8).optional(),
  baseUrl: z.url().optional(),
  model: z.string().min(1).max(100).default(DEFAULT_CONDUCTOR_MODEL),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default(DEFAULT_CONDUCTOR_EFFORT),
  maxBudgetUsd: z.number().positive().finite().optional(),
  maxTurns: z.number().int().positive().max(1_000).optional(),
  quotaFloor: z.number().min(0).max(1).default(0.2),
  sessionId: z.string().min(1).max(200).optional(),
});

const userTextSchema = z.string().trim().min(1).max(100_000);
const optionalTextSchema = z.string().max(100_000);
const base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'imagen: base64 inválido' });

export class ConductorSessionError extends Error {
  override name = 'ConductorSessionError';
}

export class ConductorSession {
  readonly id: string;
  readonly agentId = CONDUCTOR_AGENT_ID;
  readonly projectId: string | null;
  readonly model: string;
  /** Modo con el que se armó la sesión (`allowedTools` y prompt). */
  readonly mode: MindMode | undefined;
  /** `allowedTools` del SDK (propias, lectura, subagentes y plugins). */
  readonly allowedTools: readonly string[];
  /** Raíces de lectura al crear la sesión (`additionalDirectories`). */
  readonly readRoots: readonly string[];
  readonly tools: ConductorTools;
  /** Avisos de configuración (p. ej. URL de la API sin cifrar). */
  readonly warnings: readonly string[];

  readonly #options: Options;
  readonly #query: ConductorQueryFn;
  readonly #abort = new AbortController();
  readonly #input = new AsyncQueue<SDKUserMessage>();
  readonly #secrets: readonly string[];
  readonly #translator: SdkMessageTranslator | undefined;
  #stream: ReturnType<ConductorQueryFn> | undefined;
  #reading = false;
  #closed = false;

  constructor(opts: ConductorSessionOptions) {
    const o = optionsSchema.parse(opts);
    this.id = o.sessionId ?? randomUUID();
    this.projectId = o.projectId;
    this.model = o.model;
    const env = buildEnv(opts.baseEnv ?? process.env, {
      ...o.env,
      ...(o.apiKey ? { ANTHROPIC_API_KEY: o.apiKey } : {}),
      ...(o.baseUrl ? { ANTHROPIC_BASE_URL: o.baseUrl } : {}),
    });
    this.#secrets = credentialsOf(env);
    this.#query = opts.query ?? sdkQuery;
    const now = opts.now ?? (() => new Date());

    const mode = typeof opts.mode === 'function' ? opts.mode : opts.mode === undefined ? undefined : (() => opts.mode as MindMode);
    this.mode = mode?.();
    const standalone = o.projectId === null;

    this.tools = createConductorTools(opts.ports, {
      ...(o.projectId !== null ? { defaultProjectId: o.projectId } : {}),
      agentId: CONDUCTOR_AGENT_ID,
      secrets: this.#secrets,
      now,
      signal: this.#abort.signal,
      ...(mode ? { mode } : {}),
      ...(opts.autoApprove ? { autoApprove: opts.autoApprove } : {}),
      standalone,
    });

    const plugins = Object.entries(opts.mcpServers ?? {}).map(([name, config]) => [mcpServerNameSchema.parse(name), config] as const);
    const unavailable = new Set<string>([
      ...(standalone ? FLEET_TOOL_NAMES.map(mcpToolName) : []),
      ...(this.mode === 'plan' ? [mcpToolName('delegar')] : []),
    ]);
    const builtins = [...READ_ONLY_TOOLS, SUBAGENT_TOOL];
    const allowedTools = [
      ...CONDUCTOR_TOOL_NAMES.map(mcpToolName).filter((n) => !unavailable.has(n)),
      ...builtins,
      ...plugins.map(([name]) => `mcp__${name}__*`),
    ];
    this.allowedTools = allowedTools;
    const extraRoots = [...(opts.extraRoots ?? [])];
    const rootsOption = opts.readRoots;
    const readRoots = (): string[] => [...extraRoots, ...(typeof rootsOption === 'function' ? rootsOption() : (rootsOption ?? []))];
    this.readRoots = [...new Set(readRoots())];
    const fleetTools = new Set(FLEET_TOOL_NAMES.map(mcpToolName));
    const guard = createToolGuard({
      allowedTools,
      cwd: o.cwd,
      readRoots,
      denyPaths: [...(opts.denyPaths ?? [])],
      deny: (name) => {
        if (standalone && fleetTools.has(name)) return `${name} no está disponible para un agente suelto (sin proyecto ni flota).`;
        if (name === mcpToolName('delegar') && mode?.() === 'plan') return 'delegar no está disponible en modo plan: el usuario aprueba y la tarea pasa sola a la flota.';
        return undefined;
      },
    });

    const warnings: string[] = [];
    const baseUrl = env.ANTHROPIC_BASE_URL;
    if (baseUrl && /^http:\/\//i.test(baseUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(baseUrl)) {
      warnings.push('La URL de la API usa HTTP sin cifrar: la clave y los prompts viajan en claro.');
    }
    if (!this.#secrets.length) warnings.push('Falta ANTHROPIC_API_KEY: el orquestador solo funciona con la clave de API (no usa sesión de Claude Code).');
    this.warnings = warnings;

    const onStderr = opts.onStderr;
    this.#options = {
      model: o.model,
      effort: o.effort,
      cwd: o.cwd,
      env,
      abortController: this.#abort,
      systemPrompt: buildConductorSystemPrompt({
        projectId: o.projectId,
        projectDir: o.cwd,
        ...(this.mode ? { mode: this.mode } : {}),
        ...(extraRoots.length ? { extraRoots } : {}),
        date: now(),
        quotas: opts.ports.quotas.all(),
        quotaFloor: o.quotaFloor,
        notes: opts.notes,
        secrets: this.#secrets,
      }),
      mcpServers: { ...Object.fromEntries(plugins), [this.tools.serverName]: this.tools.server },
      strictMcpConfig: true,
      tools: builtins,
      allowedTools,
      disallowedTools: [...BLOCKED_TOOLS],
      permissionMode: 'dontAsk',
      // La barrera es el hook (ve también a los subagentes). `canUseTool` no se pasa: con `allowedTools`
      // completos el SDK nunca lo consultaría (aviso CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).
      hooks: { PreToolUse: [{ hooks: [guard.hook] }] },
      agents: { ...CONDUCTOR_SUBAGENTS },
      // Aislado de la sesión y los ajustes de usuario de Claude Code (permisos, hooks o MCP ajenos).
      settingSources: [...(opts.settingSources ?? [])],
      forwardSubagentText: true,
      includePartialMessages: opts.includePartialMessages ?? false,
      ...(this.readRoots.length ? { additionalDirectories: [...this.readRoots] } : {}),
      ...(o.maxBudgetUsd !== undefined ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
      ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable } : {}),
      ...(onStderr ? { stderr: (data: string) => onStderr(redactSecrets(data, this.#secrets)) } : {}),
    };

    const t = opts.translator;
    this.#translator =
      typeof t === 'function' ? t({ agentId: this.agentId, sessionId: this.id, cwd: o.cwd, secrets: this.#secrets }) : t;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Envía un mensaje del usuario. La primera llamada arranca la conversación con el SDK. Las imágenes van como
   * bloques `image` (base64) antes del texto; con imágenes el texto puede ir vacío.
   */
  send(text: string, opts: SendOptions = {}): void {
    if (this.#closed) throw new ConductorSessionError('La sesión está cerrada');
    const images = opts.images ?? [];
    if (images.length > 20) throw new ConductorSessionError('Como mucho 20 imágenes por mensaje');
    const blocks: Exclude<SDKUserMessage['message']['content'], string> = [];
    for (const image of images) {
      if (!IMAGE_MEDIA_TYPES.includes(image.mediaType)) throw new ConductorSessionError(`Tipo de imagen no admitido: ${String(image.mediaType)}`);
      if (image.data.length > MAX_IMAGE_BASE64_BYTES) throw new ConductorSessionError(imageTooLarge(image.name ?? 'imagen', image.data.length));
      blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: base64Schema.parse(image.data) } });
    }
    let message: SDKUserMessage['message'];
    if (blocks.length) {
      const content = optionalTextSchema.parse(text);
      if (content.trim()) blocks.push({ type: 'text', text: content });
      message = { role: 'user', content: blocks };
    } else {
      message = { role: 'user', content: userTextSchema.parse(text) };
    }
    this.#start();
    this.#input.push({ type: 'user', message, parent_tool_use_id: null });
  }

  /** Tacha la clave de la sesión y los patrones de `redactSecrets` (texto de la respuesta antes de guardarlo). */
  redact(text: string): string {
    return redactSecrets(text, this.#secrets);
  }

  /** Mensajes crudos del SDK. Un solo lector por sesión (este o `events()`). */
  messages(): AsyncIterable<SDKMessage> {
    if (this.#reading) throw new ConductorSessionError('La sesión ya tiene un lector');
    this.#reading = true;
    return this.#start();
  }

  /** Cada mensaje del SDK con sus eventos (traductor inyectado, clave tachada). Un solo lector por sesión. */
  stream(): AsyncIterable<ConductorUpdate> {
    const translator = this.#translator;
    if (!translator) throw new ConductorSessionError('Falta el traductor de mensajes (opción translator)');
    const messages = this.messages();
    const secrets = this.#secrets;
    return (async function* () {
      for await (const message of messages) yield { message, events: translator.translate(message).map((e) => redactDeep(e, secrets)) };
    })();
  }

  /** Mensajes del SDK pasados por el traductor inyectado, con la clave tachada. */
  events(): AsyncIterable<AgentEvent> {
    const updates = this.stream();
    return (async function* () {
      for await (const update of updates) yield* update.events;
    })();
  }

  /** Detiene el turno en curso sin cerrar la conversación. */
  async interrupt(): Promise<void> {
    await this.#stream?.interrupt?.();
  }

  /** Cierra la conversación: termina la entrada, aborta el proceso del SDK y libera recursos. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.end();
    this.#abort.abort();
    this.#stream?.close?.();
  }

  #start(): ReturnType<ConductorQueryFn> {
    this.#stream ??= this.#query({ prompt: this.#input, options: this.#options });
    return this.#stream;
  }
}

/** `session_id` del SDK de un mensaje (para reanudar con `resume`). */
export function sdkSessionIdOf(message: SDKMessage): string | undefined {
  const id = (message as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : undefined;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Mensaje claro para una imagen que la API rechazaría (el tope cuenta el base64). */
export function imageTooLarge(name: string, base64Bytes: number): string {
  return `La imagen «${name}» es demasiado grande para la mente: ocupa ${mb(base64Bytes)} en base64 y el tope de la API es 5 MB en base64 (unos 3,7 MB de archivo). Redúcela y vuelve a adjuntarla.`;
}

/**
 * Entorno del proceso del SDK. `Options.env` REEMPLAZA el entorno (no lo mezcla): base sin las variables de
 * una sesión de Claude Code anfitriona + entorno de la sesión (clave y URL, solo en memoria) + id del cliente.
 */
export function buildEnv(base: Readonly<Record<string, string | undefined>>, sessionEnv: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  // Si el orquestador corre dentro de Claude Code, el subproceso no debe creerse anidado.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Con una clave explícita no se mezcla otra credencial heredada.
  if (sessionEnv.ANTHROPIC_API_KEY) delete env.ANTHROPIC_AUTH_TOKEN;
  Object.assign(env, sessionEnv);
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CONDUCTOR_CLIENT_APP;
  return env;
}

/** Credenciales presentes en el entorno: se tachan en prompt, herramientas, eventos y stderr. */
export function credentialsOf(env: Readonly<Record<string, string | undefined>>): string[] {
  return [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

/** Cola asíncrona de un solo lector: la entrada en streaming del SDK. */
class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #ended = false;

  push(item: T): void {
    if (this.#ended) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  end(): void {
    this.#ended = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift() as T, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
