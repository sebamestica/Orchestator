import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentConfigSchema, agentEventSchema, redactSecrets } from '../../../shared/index.ts';
import type { AgentAdapter, AgentConfig, AgentEvent, ProbeResult, RunContext, TaskBrief } from '../../../shared/index.ts';
import { briefHints, effortFor, runHints, type Effort } from '../../brief/reasoning.ts';
import { renderBrief } from '../../brief/render-brief.ts';
import { bearerToken, mcpEnvName, mcpSecrets, pluginsSection, safeGrant, type McpGrant, type McpServerMap, type McpServerSource } from '../../plugins/mcp.ts';
import { runJsonl } from '../../process/run-jsonl.ts';
import { relativizeChange } from '../common/paths.ts';
import { resolveCodexExecutable } from './executable.ts';
import type { CodexExecutable } from './executable.ts';
import { classifyCodexError, isCodexErrorLine, translateCodexEvent } from './translate.ts';
import type { EventBody } from './translate.ts';

export interface CodexAdapterOptions {
  executable?: CodexExecutable;
  runner?: typeof runJsonl;
  /** Servidores MCP de los plugins para cada ejecución (`PluginService.source()`). */
  plugins?: McpServerSource;
}

/** Cadena TOML básica: el escape de JSON es válido en TOML (`\\`, `\"`, `\uXXXX`). */
const tomlString = (value: string): string => JSON.stringify(value);

/**
 * Techo del esfuerzo de Codex al reintentar: `xhigh` no lo admiten todos sus modelos y la flota no le da tareas
 * `high` (van a Claude).
 */
export const CODEX_MAX_EFFORT: Effort = 'high';

/**
 * `-c model_reasoning_effort=…` según el rol y la dificultad (issue 6): low → low, medium → medium, high → high, el
 * revisor en medium; cada reintento sube un nivel hasta `CODEX_MAX_EFFORT`.
 */
export function codexEffortArgs(task: TaskBrief, retries = 0): string[] {
  return ['-c', `model_reasoning_effort=${tomlString(effortFor(task, { retries, max: CODEX_MAX_EFFORT }))}`];
}

/**
 * Servidores neutros → `-c mcp_servers.<nombre>.…` de Codex y variables para su proceso. Ningún secreto va en los
 * argumentos: `Authorization: Bearer …` → `bearer_token_env_var`, otros encabezados → `env_http_headers` y las
 * variables de un servidor stdio → `env_vars` (Codex las reenvía desde su propio entorno).
 *
 * Cada servidor entregado va con `enabled=true` (por si el usuario tiene uno igual apagado) y
 * `default_tools_approval_mode="approve"`: `codex exec` no pide aprobaciones, y sin esto las herramientas sin
 * `readOnlyHint` (p. ej. `new_page` de Chrome) fallan con «MCP tool call requires approval, but approval policy is
 * never». Es lo mismo que hace la política de Claude con `mcp__<servidor>__*`.
 */
export function codexMcpArgs(servers: McpServerMap): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const set = (name: string, key: string, toml: string) => args.push('-c', `mcp_servers.${name}.${key}=${toml}`);
  const common = (name: string, spec: McpServerMap[string]) => {
    set(name, 'enabled', 'true');
    set(name, 'default_tools_approval_mode', '"approve"');
    if (spec.toolTimeoutSec !== undefined) set(name, 'tool_timeout_sec', String(Math.max(1, Math.ceil(spec.toolTimeoutSec))));
  };
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.type === 'stdio') {
      set(name, 'command', tomlString(spec.command));
      set(name, 'args', `[${spec.args.map(tomlString).join(',')}]`);
      const vars = Object.entries(spec.env ?? {});
      for (const [k, v] of vars) env[k] = v;
      if (vars.length) set(name, 'env_vars', `[${vars.map(([k]) => tomlString(k)).join(',')}]`);
      common(name, spec);
      continue;
    }
    set(name, 'url', tomlString(spec.url));
    const headerVars: string[] = [];
    for (const [header, value] of Object.entries(spec.headers)) {
      const token = header.toLowerCase() === 'authorization' ? bearerToken(value) : undefined;
      if (token) {
        const var_ = mcpEnvName(name, 'token');
        env[var_] = token;
        set(name, 'bearer_token_env_var', tomlString(var_));
      } else {
        const var_ = mcpEnvName(name, header);
        env[var_] = value;
        headerVars.push(`${tomlString(header)}=${tomlString(var_)}`);
      }
    }
    if (headerVars.length) set(name, 'env_http_headers', `{${headerVars.join(',')}}`);
    common(name, spec);
  }
  return { args, env };
}

/** Plugins de Codex con navegador propio (marketplace `openai-bundled`). */
export const CODEX_BROWSER_PLUGINS = ['browser@openai-bundled', 'chrome@openai-bundled', 'computer-use@openai-bundled', 'unified-computer-use@openai-bundled'] as const;
/** Funciones de Codex de navegador y control del equipo. */
export const CODEX_BROWSER_FEATURES = ['browser_use', 'browser_use_external', 'in_app_browser', 'computer_use'] as const;
/** Servidores MCP de navegador que Codex puede tener en su configuración global y Berland no entrega. */
export const CODEX_BROWSER_SERVERS = ['node_repl', 'chrome-personal', 'chrome-agente', 'chrome-devtools'] as const;

/**
 * Apaga los navegadores propios de Codex en una ejecución de Berland, solo por argumentos (`~/.codex/config.toml` no
 * se toca). Comprobado con codex-cli 0.165.0 sin gastar cupo (issue 11):
 * - `-c plugins.<id>.enabled=false` quita del prompt las skills `browser:control-in-app-browser` y
 *   `chrome:control-chrome` (`codex debug prompt-input`). La ruta va sin comillas: `-c` la divide por puntos y
 *   `plugins."chrome@…"` no tiene efecto.
 * - `node_repl` es el motor de esos plugins (`BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"`).
 * - Los servidores de navegador que Berland no entrega (`chrome-personal` sin plugin, `chrome-agente`, …) quedan con
 *   `command` + `enabled=false`: así son válidos y están apagados existan o no (con solo `enabled=false`, uno que no
 *   existe rompe la configuración: «invalid transport»).
 */
export function codexBrowserOffArgs(granted: readonly string[] = []): string[] {
  const args: string[] = [];
  for (const id of CODEX_BROWSER_PLUGINS) args.push('-c', `plugins.${id}.enabled=false`);
  for (const feature of CODEX_BROWSER_FEATURES) args.push('-c', `features.${feature}=false`);
  for (const name of CODEX_BROWSER_SERVERS) {
    if (granted.includes(name)) continue;
    args.push('-c', `mcp_servers.${name}.command=${tomlString('cmd.exe')}`, '-c', `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

/** Argumentos de navegador y plugins para `codex exec`: primero lo que se apaga, luego lo que entrega Berland. */
export function codexPluginArgs(servers: McpServerMap): { args: string[]; env: Record<string, string> } {
  const mcp = codexMcpArgs(servers);
  return { args: [...codexBrowserOffArgs(Object.keys(servers)), ...mcp.args], env: mcp.env };
}

export class CodexCliAdapter implements AgentAdapter {
  readonly config: AgentConfig;
  private readonly executable: CodexExecutable;
  private readonly runner: typeof runJsonl;
  private readonly plugins: McpServerSource | undefined;

  constructor(config: AgentConfig, options: CodexAdapterOptions = {}) {
    this.config = agentConfigSchema.parse(config);
    this.executable = options.executable ?? resolveCodexExecutable();
    this.runner = options.runner ?? runJsonl;
    this.plugins = options.plugins;
  }

  async probe(): Promise<ProbeResult> {
    const result: ProbeResult = { agentId: this.config.id, installed: false, authenticated: false, models: [], quotaMethod: 'codex-ratelimits', warnings: [] };
    for (const args of [['--version'], ['login', 'status']]) {
      let output = '';
      let ok = false;
      try {
        for await (const line of this.runner({ command: this.executable.command, args: [...this.executable.args, ...args], cwd: process.cwd(), timeoutMs: 10_000 })) {
          if (line.kind === 'exit') ok = line.code === 0 && !line.aborted && !line.timedOut;
          else output += `${line.line}\n`;
        }
      } catch { result.warnings.push('No se pudo iniciar Codex'); }
      if (args[0] === '--version') {
        const version = /codex-cli\s+([^\s]+)/.exec(output)?.[1];
        result.installed = ok && version !== undefined;
        if (version) result.version = version;
      } else result.authenticated = ok && /^\s*Logged in\b/im.test(output);
      if (!ok) result.warnings.push(redactSecrets(output.trim()) || 'Codex no respondió correctamente');
    }
    return result;
  }

  async *run(task: TaskBrief, ctx: RunContext): AsyncGenerator<AgentEvent> {
    const grant = await safeGrant(this.plugins, { agentId: this.config.id, kind: 'codex-cli', taskId: task.id, signal: ctx.signal });
    try {
      yield* this.runWith(task, ctx, grant);
    } finally {
      await grant.release();
    }
  }

  private async *runWith(task: TaskBrief, ctx: RunContext, grant: McpGrant): AsyncGenerator<AgentEvent> {
    const plugins = codexPluginArgs(grant.servers);
    const pluginNames = Object.keys(grant.servers);
    const childEnv = { ...ctx.env, ...plugins.env };
    const secrets = [...Object.values(ctx.env), ...mcpSecrets(grant.servers)];
    const section = pluginsSection(grant);
    // Codex carga AGENTS.md de la raíz por su cuenta: el encargo no pide volver a leerlo.
    const brief = renderBrief(task, ctx.handoff, { rulesInSystemPrompt: true, ...briefHints(ctx) });
    const sessionId = randomUUID();
    let seq = 0;
    let failed = false;
    let completed = false;
    let exited = false;
    const emit = (body: EventBody): AgentEvent => agentEventSchema.parse(JSON.parse(redactSecrets(JSON.stringify({
      ...body, sessionId, agentId: this.config.id, seq: seq++, ts: new Date().toISOString(),
    }), secrets)));
    yield emit({ type: 'status', payload: { state: 'starting', ...(pluginNames.length ? { detail: `plugins: ${pluginNames.join(', ')}` } : {}) } });
    try {
      if (ctx.signal.aborted) {
        failed = true;
        yield emit({ type: 'error', payload: { code: 'cancelled', message: 'Ejecución cancelada antes de iniciar' } });
      } else {
        await mkdir(join(ctx.worktreePath, '.orq'), { recursive: true });
        for await (const line of this.runner({ command: this.executable.command,
          args: [...this.executable.args, 'exec', '--json', ...codexEffortArgs(task, runHints(ctx).retries), ...plugins.args, '-s', 'workspace-write', '-C', ctx.worktreePath,
            '-o', join(ctx.worktreePath, '.orq', 'ultimo-mensaje.md'), ...(this.config.model ? ['-m', this.config.model] : []), '-'],
          cwd: ctx.worktreePath, stdin: section ? `${brief}\n\n${section}\n` : brief,
          env: childEnv, signal: ctx.signal, timeoutMs: ctx.timeoutMs })) {
          if (line.kind === 'exit') {
            exited = true;
            if (line.code !== 0 || line.aborted || line.timedOut) {
              if (!failed || line.aborted || line.timedOut) yield emit({ type: 'error', payload: {
                code: line.aborted ? 'cancelled' : line.timedOut ? 'timeout' : 'crash', message: `Codex terminó con código ${String(line.code)}`,
              } });
              failed = true;
            }
          } else if (line.kind === 'json') {
            const events = translateCodexEvent(line.value, line.line, this.config.model ? { model: this.config.model } : {}).map((event) => relativizeChange(event, ctx.worktreePath));
            for (const event of events) {
              if (event.type === 'error') failed = true;
              if (event.type === 'usage') completed = true;
              yield emit(event);
            }
          } else {
            const code = isCodexErrorLine(line.line) ? classifyCodexError(line.line) : 'unknown';
            if (code !== 'unknown') { failed = true; yield emit({ type: 'error', payload: { code, message: line.line } }); }
            else yield emit({ type: 'raw', payload: { source: line.kind === 'stderr' ? 'codex-stderr' : 'codex-cli', line: line.line } });
          }
        }
        if (!failed && (!completed || !exited)) {
          failed = true;
          yield emit({ type: 'error', payload: { code: 'invalid_output', message: 'Codex terminó sin confirmar el turno y la salida' } });
        }
      }
    } catch (error) {
      failed = true;
      yield emit({ type: 'error', payload: { code: 'crash', message: error instanceof Error ? error.message : 'No se pudo ejecutar Codex' } });
    }
    // El CLI escribe -o directamente; reducir la permanencia de texto sensible en ese artefacto.
    try {
      const outputPath = join(ctx.worktreePath, '.orq', 'ultimo-mensaje.md');
      const original = await readFile(outputPath, 'utf8');
      const clean = redactSecrets(original, secrets);
      if (clean !== original) await writeFile(outputPath, clean, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        failed = true;
        yield emit({ type: 'error', payload: { code: 'crash', message: 'No se pudo sanear el último mensaje de Codex' } });
      }
    }
    yield emit({ type: 'done', payload: { ok: !failed } });
  }
}
