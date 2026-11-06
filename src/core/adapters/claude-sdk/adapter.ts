import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { CanUseTool, EffortLevel, HookCallbackMatcher, HookEvent, McpServerConfig, Options, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentAdapter } from '../../../shared/contracts.ts';
import type { AgentConfig, AgentEvent, ProbeResult, RunContext, TaskBrief } from '../../../shared/index.ts';
import { redactSecrets } from '../../../shared/index.ts';
import { briefHints, effortFor, runHints, taskRole, type TaskRole } from '../../brief/reasoning.ts';
import { renderBrief } from '../../brief/render-brief.ts';
import { assertRealInside } from '../../memory/safe-fs.ts';
import { mcpEnvName, mcpSecrets, pluginsSection, safeGrant, type McpGrant, type McpServerMap, type McpServerSource } from '../../plugins/mcp.ts';
import type { LiveSpendEntry } from '../../quota/live-spend.ts';
import { readSpentUsd, type SpentUsdFn } from '../../quota/manual-budget.ts';
import { classifyClaudeError } from './errors.ts';
import { createPolicyHook, createToolPolicy, type ToolPolicyOptions } from './permissions.ts';
import { ClaudeSdkTranslator } from './translate.ts';

/**
 * Adaptador del worker Claude con `@anthropic-ai/claude-agent-sdk` (`query`).
 * - `cwd` = worktree de la tarea; `env` = entorno del proceso + `ctx.env` (ANTHROPIC_API_KEY,
 *   ANTHROPIC_BASE_URL). Ojo: en el SDK `env` REEMPLAZA el entorno del subproceso, no lo mezcla.
 * - Permisos: la política de `permissions.ts` corre en un hook `PreToolUse` del host, antes de las reglas
 *   y del modo, y decide cada llamada (también de subagentes); `canUseTool` repite la política como
 *   respaldo y `permissionMode: 'acceptEdits'` solo actúa si el hook no responde.
 * - Configuración ejecutable del proyecto aislada: `settingSources: []` (no se cargan `.claude/settings.json`,
 *   sus reglas allow, hooks de comandos, `.mcp.json` ni plugins del repo) y `strictMcpConfig`. Las reglas
 *   del repo (`CLAUDE.md`, `AGENTS.md` de la raíz del worktree) van como texto en el prompt de sistema
 *   de Claude Code (`preset: 'claude_code'` + `append`).
 * - Cancelación con `ctx.signal`, tope de tiempo `ctx.timeoutMs` y tope de gasto: `config.budgetUsd` del agente y,
 *   si el Supervisor lo pasa (`RunHints.budgetUsd`), lo que le queda a la tarea; el menor va como `maxBudgetUsd`.
 * - Razonamiento por rol y dificultad (issue 6, `brief/reasoning.ts`): el autor con esfuerzo low/medium/high según la
 *   dificultad y el revisor en `medium`; cada reintento sube un nivel. Las revisiones de tareas low y medium van a
 *   `reviewModel` (Sonnet 5.5). El prompt de sistema va con `excludeDynamicSections` para que su prefijo sea igual en
 *   todos los workers del proyecto y la caché se comparta.
 * - Commits sin atribución del agente: `settings.attribution` vacío y una regla en el prompt de sistema.
 * - Plugins (F5): `plugins` entrega servidores MCP por ejecución (Chrome, Canva). Van en `mcpServers` con los
 *   secretos como `${VAR}` (Claude Code los expande del entorno: el token no viaja en `--mcp-config`), sus
 *   herramientas `mcp__<servidor>__*` quedan permitidas en la política y sus notas se agregan al prompt de sistema.
 */

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
/** Modelo de las revisiones de tareas low y medium (decisión del usuario, issue 6). */
export const REVIEW_MODEL = 'claude-sonnet-5-5';
/** Dificultades cuyas revisiones van a `REVIEW_MODEL`; las de `high` las hace el modelo del agente. */
const CHEAP_REVIEWS: ReadonlySet<TaskBrief['difficulty']> = new Set(['low', 'medium']);
/** Los commits y PR de los agentes van sin «Co-Authored-By» ni «Generated with» (regla del usuario). */
export const NO_ATTRIBUTION = { commit: '', pr: '', sessionUrl: false } as const;
export const NO_ATTRIBUTION_RULE =
  '# Commits\n\nNo agregues trailers «Co-Authored-By» ni líneas «Generated with …» a los mensajes de commit ni a los PR: el trabajo se confirma a nombre del usuario.';
export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = [];
/** Archivos de reglas de la raíz del worktree que se pasan en el prompt de sistema. */
export const RULES_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
const RULES_MAX_CHARS = 40_000;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const CLIENT_APP = 'orquestador/0.1.0';
const STDERR_LINES = 20;

/** Firma mínima de `query` (inyectable en pruebas). */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<unknown> & { close?: () => void };

export interface ClaudeSdkAdapterOptions {
  config: AgentConfig;
  /** Entorno para `probe()` (en `run()` manda `ctx.env`). Por defecto `process.env`. */
  probeEnv?: () => Readonly<Record<string, string | undefined>> | Promise<Readonly<Record<string, string | undefined>>>;
  /** Entorno base del subproceso (por defecto `process.env`); `ctx.env` se aplica encima. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** `query` del SDK; por defecto se importa `@anthropic-ai/claude-agent-sdk` al ejecutar. */
  query?: QueryFn;
  /** `fetch` para `probe()` (cliente `@anthropic-ai/sdk`). */
  fetch?: typeof globalThis.fetch;
  /** Gasto ya registrado del agente en USD (p. ej. suma en SQLite), para el tope `config.budgetUsd`. */
  spentUsd?: SpentUsdFn;
  /**
   * Cuenta en curso de cada ejecución en el saldo común de la clave (`LiveSpend`): con ella, `spentUsd` incluye lo que
   * gastan a la vez la mente y otras tareas, y la ejecución se corta si entre todos superan `config.budgetUsd`.
   */
  liveSpend?: () => LiveSpendEntry;
  /** Por defecto `[]`: no se carga configuración ejecutable del proyecto ni del usuario. */
  settingSources?: readonly SettingSource[];
  /** `canUseTool` de respaldo; por defecto `createToolPolicy` con la misma política del hook. */
  canUseTool?: (worktreePath: string, policy: ToolPolicyOptions) => CanUseTool;
  /** Carpetas o archivos legibles además del worktree (p. ej. `C:\dev\agent-hub\skills`). */
  readOnlyPaths?: readonly string[];
  /** Herramientas permitidas a mano además de las integradas (p. ej. `WebFetch`, `mcp__orq__*`). */
  extraTools?: readonly string[];
  /** Servidores MCP de los plugins para cada ejecución (`PluginService.source()`). */
  plugins?: McpServerSource;
  /**
   * Opciones extra del SDK (p. ej. `effort`, `maxTurns`, `mcpServers`). No pueden pisar cwd, env, permisos,
   * fuentes de configuración ni señal; sus hooks se agregan después del hook de la política.
   */
  extraOptions?: Partial<Options>;
  /**
   * Modelo de las revisiones de tareas low y medium (por defecto `REVIEW_MODEL`); `null`: el del agente. Las de
   * tareas high siempre usan el del agente.
   */
  reviewModel?: string | null;
  /** Seguir esperando los reintentos del SDK ante 401/403 o falta de saldo (por defecto se corta al primero). */
  retryPermanentErrors?: boolean;
  /** Recibe cada mensaje crudo del SDK (para grabar fixtures o depurar). ¡Puede contener rutas y texto del usuario! */
  onSdkMessage?: (message: unknown) => void;
  now?: () => Date;
  newSessionId?: () => string;
  /** Versión informada por `probe()`; por defecto la del paquete instalado. */
  sdkVersion?: string;
  probeTimeoutMs?: number;
}

/** Versión instalada de `@anthropic-ai/claude-agent-sdk` (undefined si no está). */
export function installedSdkVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = z.looseObject({ version: z.string() }).parse(JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')));
    return pkg.version;
  } catch {
    return undefined;
  }
}

const modelListSchema = z.looseObject({ id: z.string().min(1) });

function secretsOf(env: Readonly<Record<string, string | undefined>>): string[] {
  return [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

/** Rutas absolutas de skills y notas que cita el encargo: se permiten para lectura. */
export function taskReadRoots(task: TaskBrief): string[] {
  return [...task.skillRefs, ...task.contextRefs]
    .filter((ref) => isAbsolute(ref))
    .map((ref) => (basename(ref).toLowerCase() === 'skill.md' ? dirname(ref) : ref));
}

/**
 * Texto de `CLAUDE.md` y `AGENTS.md` de la raíz del worktree para el prompt de sistema (con
 * `settingSources: []` el SDK no los lee). Solo archivos cuya ruta real queda dentro del worktree.
 */
export async function loadRepoRules(worktreePath: string): Promise<string | undefined> {
  const parts: string[] = [];
  for (const name of RULES_FILES) {
    const file = join(worktreePath, name);
    try {
      await assertRealInside(worktreePath, file);
      let text = await readFile(file, 'utf8');
      if (text.length > RULES_MAX_CHARS) text = `${text.slice(0, RULES_MAX_CHARS)}\n[… recortado]`;
      // Un CLAUDE.md que solo importa AGENTS.md (`@AGENTS.md`) no aporta nada aparte.
      if (name === 'CLAUDE.md' && /^\s*(?:#.*\n\s*)*@AGENTS\.md\s*$/i.test(text)) continue;
      parts.push(`## ${name}\n\n${text.trim()}`);
    } catch {
      /* no existe o sale del worktree */
    }
  }
  if (parts.length === 0) return undefined;
  return [
    '# Reglas del repositorio',
    'El orquestador carga estas reglas desde la raíz de tu worktree. No se carga la configuración ejecutable del proyecto (.claude/settings.json, hooks, MCP).',
    ...parts,
  ].join('\n\n');
}

/**
 * Servidores neutros → `mcpServers` del SDK. Cada encabezado (y cada variable de un servidor stdio) se pasa como
 * `${ORQ_MCP_…}` y su valor va en `env`: el SDK serializa `mcpServers` en `--mcp-config` (argumentos del proceso) y
 * Claude Code expande `${VAR}` en `command`, `args`, `env`, `url` y `headers`.
 */
export function claudeMcpOptions(servers: McpServerMap): { mcpServers: Record<string, McpServerConfig>; env: Record<string, string> } {
  const mcpServers: Record<string, McpServerConfig> = {};
  const env: Record<string, string> = {};
  const ref = (server: string, key: string, value: string): string => {
    const name = mcpEnvName(server, key);
    env[name] = value;
    return `\${${name}}`;
  };
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.type === 'stdio') {
      const vars = Object.entries(spec.env ?? {}).map(([k, v]) => [k, ref(name, k, v)] as const);
      mcpServers[name] = { type: 'stdio', command: spec.command, args: [...spec.args], ...(vars.length ? { env: Object.fromEntries(vars) } : {}) };
    } else {
      mcpServers[name] = { type: 'http', url: spec.url, headers: Object.fromEntries(Object.entries(spec.headers).map(([h, v]) => [h, ref(name, h, v)])) };
    }
  }
  return { mcpServers, env };
}

function mergeHooks(policy: HookCallbackMatcher, extra: Options['hooks']): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return { ...extra, PreToolUse: [policy, ...(extra?.PreToolUse ?? [])] };
}

export function insecureUrlWarning(url: string | undefined): string | undefined {
  if (!url || !/^http:\/\//i.test(url)) return undefined;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* URL inválida: se muestra tal cual */
  }
  return `La URL base ${host} usa http://: conexión sin cifrar. La clave, los encargos y el código viajan en claro.`;
}

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly config: AgentConfig;
  readonly #opts: ClaudeSdkAdapterOptions;

  constructor(opts: ClaudeSdkAdapterOptions) {
    if (opts.config.kind !== 'claude-sdk') throw new Error(`ClaudeSdkAdapter requiere kind 'claude-sdk' (recibió '${opts.config.kind}').`);
    this.config = opts.config;
    this.#opts = opts;
  }

  get model(): string {
    return this.config.model ?? DEFAULT_CLAUDE_MODEL;
  }

  /**
   * Modelo y esfuerzo de una ejecución: el rol sale de `isReviewTask` y el esfuerzo de la dificultad, un nivel más por
   * reintento. Un `effort` fijo en `extraOptions` manda sobre la política.
   */
  profile(task: TaskBrief, retries = 0): { role: TaskRole; model: string; effort: EffortLevel } {
    const role = taskRole(task);
    const reviewModel = this.#opts.reviewModel === undefined ? REVIEW_MODEL : this.#opts.reviewModel;
    const model = role === 'reviewer' && reviewModel && CHEAP_REVIEWS.has(task.difficulty) ? reviewModel : this.model;
    return { role, model, effort: this.#opts.extraOptions?.effort ?? effortFor(task, { retries }) };
  }

  /** Entorno del subproceso: base (sin variables de una sesión de Claude Code anfitriona) + baseUrl + ctx.env. */
  buildEnv(ctxEnv: Readonly<Record<string, string>>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#opts.baseEnv ?? process.env)) if (v !== undefined) env[k] = v;
    // Si el orquestador corre dentro de Claude Code, el subproceso no debe creerse anidado.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (this.config.baseUrl) env.ANTHROPIC_BASE_URL = this.config.baseUrl;
    Object.assign(env, ctxEnv);
    env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
    return env;
  }

  async probe(): Promise<ProbeResult> {
    const env = (await this.#opts.probeEnv?.()) ?? process.env;
    const baseUrl = this.config.baseUrl ?? env.ANTHROPIC_BASE_URL;
    const warnings: string[] = [];
    const insecure = insecureUrlWarning(baseUrl);
    if (insecure) warnings.push(insecure);
    const version = this.#opts.sdkVersion ?? installedSdkVersion();
    const base = { agentId: this.config.id, installed: version !== undefined, quotaMethod: 'manual-budget' as const };
    if (version === undefined) warnings.push('No se encontró @anthropic-ai/claude-agent-sdk.');
    if (this.config.budgetUsd === undefined) warnings.push('Sin presupuesto (budgetUsd): el servidor no informa saldo y el gasto no tendrá tope.');

    const apiKey = env.ANTHROPIC_API_KEY;
    const authToken = env.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey && !authToken) {
      warnings.push('Falta ANTHROPIC_API_KEY (o ANTHROPIC_AUTH_TOKEN).');
      return { ...base, version, authenticated: false, models: [], warnings };
    }
    const secrets = secretsOf(env);
    const client = new Anthropic({
      apiKey: apiKey ?? null,
      authToken: apiKey ? null : (authToken ?? null),
      baseURL: baseUrl ?? DEFAULT_BASE_URL,
      maxRetries: 0,
      timeout: this.#opts.probeTimeoutMs ?? 15_000,
      ...(this.#opts.fetch ? { fetch: this.#opts.fetch } : {}),
    });

    let authenticated = false;
    let models: string[] = [];
    try {
      // Lista de modelos: no gasta tokens.
      for await (const info of client.models.list({ limit: 100 })) {
        const parsed = modelListSchema.safeParse(info);
        if (parsed.success) models.push(parsed.data.id);
      }
      authenticated = true;
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) {
        // El servidor no expone /v1/models: llamada mínima (1 token de salida).
        try {
          await client.messages.create({ model: this.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
          authenticated = true;
          models = [this.model];
        } catch (inner) {
          authenticated = keyAcceptedDespite(inner);
          warnings.push(describeProbeError(inner, secrets));
        }
      } else {
        // 402/429: la clave es válida aunque no haya saldo o cupo ahora.
        authenticated = keyAcceptedDespite(err);
        warnings.push(describeProbeError(err, secrets));
      }
    }
    if (authenticated && models.length > 0 && !models.includes(this.model)) {
      warnings.push(`El modelo ${this.model} no aparece en la lista del servidor.`);
    }
    return { ...base, version, authenticated, models, warnings: warnings.map((w) => redactSecrets(w, secrets)) };
  }

  async *run(task: TaskBrief, ctx: RunContext): AsyncGenerator<AgentEvent> {
    const grant = await safeGrant(this.#opts.plugins, { agentId: this.config.id, kind: 'claude-sdk', taskId: task.id, signal: ctx.signal });
    const live = this.#opts.liveSpend?.();
    try {
      yield* this.#run(task, ctx, grant, live);
    } finally {
      live?.close();
      await grant.release();
    }
  }

  /** Con la cuenta en curso abierta: ¿el gasto común de la clave (registrado + en curso de todos) supera el presupuesto? */
  async #commonBudgetExceeded(live: LiveSpendEntry | undefined): Promise<boolean> {
    const budget = this.config.budgetUsd;
    if (!live || budget === undefined || !this.#opts.spentUsd) return false;
    try {
      return (await readSpentUsd(this.#opts.spentUsd)) > budget;
    } catch {
      return false;
    }
  }

  async *#run(task: TaskBrief, ctx: RunContext, grant: McpGrant, live: LiveSpendEntry | undefined): AsyncGenerator<AgentEvent> {
    const plugins = claudeMcpOptions(grant.servers);
    const env = { ...this.buildEnv(ctx.env), ...plugins.env };
    const secrets = [...secretsOf(env), ...mcpSecrets(grant.servers)];
    const pluginNames = Object.keys(plugins.mcpServers);
    const hints = runHints(ctx);
    const profile = this.profile(task, hints.retries);
    const tr = new ClaudeSdkTranslator({
      agentId: this.config.id,
      sessionId: (this.#opts.newSessionId ?? randomUUID)(),
      now: this.#opts.now,
      secrets,
      cwd: ctx.worktreePath,
    });
    const who = `${profile.model} · ${profile.role === 'reviewer' ? 'revisión' : 'autor'} · esfuerzo ${profile.effort}`;
    yield tr.status('starting', `Claude (${who}) en ${ctx.worktreePath}${pluginNames.length ? ` · plugins: ${pluginNames.join(', ')}` : ''}`);

    // Tope de gasto: presupuesto del agente menos lo ya gastado.
    let budgetLeft: number | undefined;
    if (this.config.budgetUsd !== undefined) {
      let spent = 0;
      if (this.#opts.spentUsd) {
        try {
          spent = await readSpentUsd(this.#opts.spentUsd);
        } catch (err) {
          yield tr.error('unknown', `No se pudo leer el gasto del agente: ${(err as Error).message}`);
          yield tr.done(false);
          return;
        }
      }
      budgetLeft = this.config.budgetUsd - spent;
      if (budgetLeft <= 0) {
        yield tr.error('quota_exhausted', `Presupuesto agotado: gastados ${spent.toFixed(4)} de ${this.config.budgetUsd} USD.`);
        yield tr.done(false);
        return;
      }
    }

    // Tope de la tarea (lo que le queda según el Supervisor): manda si es menor que el del agente.
    const taskLeft = hints.budgetUsd;
    if (taskLeft !== undefined && taskLeft <= 0) {
      yield tr.error('quota_exhausted', 'Tope de gasto de la tarea agotado antes de empezar.');
      yield tr.done(false);
      return;
    }
    const taskBound = taskLeft !== undefined && (budgetLeft === undefined || taskLeft < budgetLeft);
    const cap = taskBound ? taskLeft : budgetLeft;

    if (ctx.signal.aborted) {
      yield tr.error('cancelled', 'Tarea cancelada antes de empezar.');
      yield tr.done(false);
      return;
    }

    const controller = new AbortController();
    let stopReason: 'cancelled' | 'timeout' | 'budget' | 'common-budget' | 'fatal' | undefined;
    const stop = (reason: NonNullable<typeof stopReason>) => {
      stopReason ??= reason;
      controller.abort();
    };
    const onAbort = () => stop('cancelled');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = ctx.timeoutMs > 0 ? setTimeout(() => stop('timeout'), ctx.timeoutMs) : undefined;
    const stderr: string[] = [];

    const extra = this.#opts.extraOptions ?? {};
    const configured = extra.mcpServers ?? {};
    const mcpServers = { ...configured, ...plugins.mcpServers };
    const policy: ToolPolicyOptions = {
      readRoots: [...(this.#opts.readOnlyPaths ?? []), ...taskReadRoots(task)],
      // Solo las MCP configuradas a mano en las opciones (strictMcpConfig ignora las del proyecto).
      extraTools: [...(this.#opts.extraTools ?? []), ...Object.keys(configured).map((name) => `mcp__${name}__*`)],
      // Y las de los plugins, por nombre exacto de servidor.
      mcpServers: pluginNames,
    };
    const section = pluginsSection(grant);
    const repoRules = await loadRepoRules(ctx.worktreePath);
    const rules = [repoRules, section, NO_ATTRIBUTION_RULE].filter((t): t is string => Boolean(t)).join('\n\n');
    const options: Options = {
      ...extra,
      cwd: ctx.worktreePath,
      env,
      model: profile.model,
      effort: profile.effort,
      settings: typeof extra.settings === 'string' ? extra.settings : { ...extra.settings, attribution: { ...NO_ATTRIBUTION } },
      permissionMode: 'acceptEdits',
      hooks: mergeHooks(createPolicyHook(ctx.worktreePath, policy), extra.hooks),
      canUseTool: (this.#opts.canUseTool ?? createToolPolicy)(ctx.worktreePath, policy),
      settingSources: [...(this.#opts.settingSources ?? DEFAULT_SETTING_SOURCES)],
      strictMcpConfig: true,
      mcpServers,
      // Sin las secciones dinámicas (carpeta, git status), el prefijo es el mismo en todos los workers del proyecto y su
      // caché se comparte; el SDK las pasa al primer mensaje del usuario.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: rules, excludeDynamicSections: true },
      // Texto de los subagentes con parent_tool_use_id: alimenta el árbol en vivo.
      forwardSubagentText: true,
      abortController: controller,
      stderr: (data: string) => {
        for (const line of data.split(/\r?\n/)) if (line.trim()) stderr.push(line);
        if (stderr.length > STDERR_LINES) stderr.splice(0, stderr.length - STDERR_LINES);
      },
    };
    if (cap !== undefined) options.maxBudgetUsd = cap;

    let q: (AsyncIterable<unknown> & { close?: () => void }) | undefined;
    let thrown: unknown;
    let liveUsd = 0;
    try {
      const queryFn = this.#opts.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      // Las reglas del repo ya van en el prompt de sistema: el encargo no pide volver a leerlas.
      q = queryFn({ prompt: renderBrief(task, ctx.handoff, { rulesInSystemPrompt: repoRules !== undefined, ...briefHints(ctx) }), options });
      for await (const message of q) {
        this.#opts.onSdkMessage?.(message);
        for (const event of tr.translate(message)) yield event;
        if (tr.finished) break;
        if (cap !== undefined && tr.spentUsd > cap) stop('budget');
        // Solo cuando el gasto cambió: la mente y otras tareas gastan con la misma clave mientras esta corre.
        if (live && tr.spentUsd !== liveUsd) {
          liveUsd = tr.spentUsd;
          live.set(liveUsd);
          if (await this.#commonBudgetExceeded(live)) stop('common-budget');
        }
        if (tr.fatal && !this.#opts.retryPermanentErrors) stop('fatal');
        if (stopReason) break;
      }
    } catch (err) {
      thrown = err;
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      try {
        q?.close?.();
      } catch {
        /* el proceso ya terminó */
      }
    }

    if (tr.finished) return;
    // Terminó sin `result`: se registra lo gastado hasta ahora y se informa el motivo.
    yield* tr.partialUsageEvents();
    if (stopReason === 'fatal' && tr.fatal) {
      yield tr.error(tr.fatal.code, tr.fatal.code === 'auth' ? `Autenticación rechazada: ${tr.fatal.message}` : `Sin saldo: ${tr.fatal.message}`);
    } else if (stopReason === 'budget') {
      const what = taskBound ? 'el tope de gasto de la tarea' : 'el presupuesto en curso';
      yield tr.error('quota_exhausted', `Se superó ${what}: ~${tr.spentUsd.toFixed(4)} USD de ${cap?.toFixed(4)} USD disponibles.`);
    } else if (stopReason === 'common-budget') {
      yield tr.error('quota_exhausted', `Presupuesto agotado: la clave de ${this.config.id} superó ${this.config.budgetUsd} USD entre la mente y las tareas en curso (esta llevaba ~${tr.spentUsd.toFixed(4)} USD).`);
    } else if (stopReason === 'timeout') {
      yield tr.error('timeout', `Se agotó el tiempo de la tarea (${Math.round(ctx.timeoutMs / 1000)} s).`);
    } else if (stopReason === 'cancelled') {
      yield tr.error('cancelled', 'Tarea cancelada.');
    } else {
      const message = thrown instanceof Error ? thrown.message : thrown === undefined ? 'El SDK terminó sin mensaje de resultado.' : String(thrown);
      const texts = [message, ...stderr, tr.hint?.message ?? ''];
      const code = classifyClaudeError({ texts }, tr.hint?.code ?? 'crash');
      const tail = stderr.length ? ` | stderr: ${stderr.slice(-5).join(' / ')}` : '';
      yield tr.error(code, `${message}${tail}`);
    }
    yield tr.done(false);
  }
}

function keyAcceptedDespite(err: unknown): boolean {
  return err instanceof Anthropic.APIError && (err.status === 402 || err.status === 429);
}

function describeProbeError(err: unknown, secrets: readonly string[]): string {
  let text: string;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    text = `El servidor rechazó la clave (HTTP ${err.status}).`;
  } else if (err instanceof Anthropic.APIConnectionError) {
    text = `No se pudo conectar con el servidor: ${err.message}`;
  } else if (err instanceof Anthropic.APIError) {
    const code = classifyClaudeError({ httpStatus: err.status, texts: [err.message] });
    text = code === 'quota_exhausted' ? `Sin saldo o con límite de uso (HTTP ${err.status}).` : `El servidor respondió HTTP ${err.status}: ${err.message}`;
  } else {
    text = `No se pudo comprobar la clave: ${err instanceof Error ? err.message : String(err)}`;
  }
  return redactSecrets(text, secrets);
}
