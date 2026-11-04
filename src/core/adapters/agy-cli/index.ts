import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentConfig,
  AgentEvent,
  ProbeResult,
  RunContext,
  TaskBrief,
} from '../../../shared/index.ts';
import {
  agentConfigSchema,
  agentEventSchema,
  probeResultSchema,
  redactSecrets,
} from '../../../shared/index.ts';
import { renderBrief } from '../../brief/render-brief.ts';
import { runJsonl } from '../../process/run-jsonl.ts';
import { relativizeChange } from '../common/paths.ts';
import { resolveAgyExecutable, type AgyExecutable } from './executable.ts';
import { classifyAgyError, translateAgyEvent, type EventBody } from './translate.ts';

export interface AgyAdapterOptions {
  executable?: string | AgyExecutable;
  runner?: typeof runJsonl;
}

/**
 * Texto suelto (stderr o líneas no JSON) solo hace fallar la tarea si indica cupo agotado o falta de sesión.
 * Un aviso de diagnóstico que mencione «timeout» o «abort» no es fatal: el timeout y la cancelación reales
 * los detecta runJsonl y llegan en el evento `exit`.
 */
function fatalLineCode(line: string): 'quota_exhausted' | 'auth' | undefined {
  const code = classifyAgyError(line);
  return code === 'quota_exhausted' || code === 'auth' ? code : undefined;
}

/**
 * Adaptador para agy CLI (Antigravity).
 * Ejecuta el CLI sin ventana, pasando el encargo mediante archivo en el worktree
 * y traduciendo la salida JSONL en eventos normalizados AgentEvent.
 *
 * Plugins (F5): agy todavía no recibe servidores MCP por sesión, así que este adaptador no acepta la fuente
 * `plugins` y `PluginService` no le entrega nada (`PLUGIN_AGENT_KINDS`). Comprobado con agy 1.5.0 (2026-11-04):
 * - `--settings` (ajustes solo de la sesión) rechaza la clave: «Error: --settings: unknown setting "mcpServers"».
 * - `agy mcp add` escribe la configuración global del usuario (`~/.gemini/config/mcp_config.json`): afectaría a
 *   todas sus sesiones y dejaría el token de Canva en claro en disco.
 * - Los plugins de espacio de trabajo (`.agents/plugins/<nombre>/mcp_config.json`) también irían a disco (y dentro
 *   del repo del proyecto), no a `.orq/`.
 * agy sí ve los servidores que el usuario registró a mano (hoy `chrome-personal` y `blender`), fuera del candado del
 * orquestador. Camino para F5.2: `agy acp`, cuyo `session/new` acepta `mcpServers` por sesión.
 */
export class AgyCliAdapter implements AgentAdapter {
  readonly config: AgentConfig;
  private readonly executable: AgyExecutable;
  private readonly runner: typeof runJsonl;

  constructor(config: AgentConfig, options: AgyAdapterOptions = {}) {
    this.config = agentConfigSchema.parse(config);
    this.executable = resolveAgyExecutable(options.executable);
    this.runner = options.runner ?? runJsonl;
  }

  async probe(): Promise<ProbeResult> {
    const result: ProbeResult = {
      agentId: this.config.id,
      installed: false,
      authenticated: false,
      models: [],
      quotaMethod: 'agy-usage',
      warnings: [],
    };

    // 1. Probar versión
    try {
      let versionOut = '';
      let versionOk = false;
      for await (const line of this.runner({
        command: this.executable.command,
        args: [...this.executable.args, '--version'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      })) {
        if (line.kind === 'exit') {
          versionOk = line.code === 0 && !line.aborted && !line.timedOut;
        } else {
          versionOut += `${line.line}\n`;
        }
      }
      const match = /(\d+\.\d+(?:\.\d+)?)/.exec(versionOut);
      result.installed = versionOk && match !== null;
      if (match?.[1]) {
        result.version = match[1];
      }
      if (!versionOk) {
        result.warnings.push(redactSecrets(versionOut.trim()) || 'agy --version falló');
      }
    } catch (err) {
      result.warnings.push(
        `No se pudo verificar la versión de agy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. Probar modelos
    try {
      let modelsOut = '';
      let modelsOk = false;
      const modelIds: string[] = [];
      for await (const line of this.runner({
        command: this.executable.command,
        args: [...this.executable.args, 'models'],
        cwd: process.cwd(),
        timeoutMs: 15_000,
      })) {
        if (line.kind === 'exit') {
          modelsOk = line.code === 0 && !line.aborted && !line.timedOut;
        } else if (line.kind === 'text') {
          modelsOut += `${line.line}\n`;
          const trimmed = line.line.trim();
          if (trimmed && !trimmed.toLowerCase().startsWith('fetching')) {
            const parts = trimmed.split(/[\t\s]{2,}|\t/);
            const first = parts[0]?.trim();
            if (first) {
              modelIds.push(first);
            }
          }
        } else if (line.kind === 'stderr') {
          modelsOut += `${line.line}\n`;
        }
      }
      result.models = modelIds;
      result.authenticated = modelsOk && modelIds.length > 0;
      if (!modelsOk) {
        result.warnings.push(redactSecrets(modelsOut.trim()) || 'agy models falló');
      }
    } catch (err) {
      result.warnings.push(
        `No se pudo consultar los modelos de agy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return probeResultSchema.parse(result);
  }

  async *run(task: TaskBrief, ctx: RunContext): AsyncGenerator<AgentEvent> {
    const sessionId = randomUUID();
    let seq = 0;
    let failed = false;
    let completed = false;
    let exited = false;
    // El `done` de agy (evento result) se retiene: el adaptador emite un único done, siempre al final.
    let resultDone: { ok: boolean; summary?: string } | undefined;

    const emit = (body: EventBody): AgentEvent =>
      agentEventSchema.parse(
        JSON.parse(
          redactSecrets(
            JSON.stringify({
              ...body,
              sessionId,
              agentId: this.config.id,
              seq: seq++,
              ts: new Date().toISOString(),
            }),
            Object.values(ctx.env),
          ),
        ),
      );

    yield emit({ type: 'status', payload: { state: 'starting' } });

    try {
      if (ctx.signal.aborted) {
        failed = true;
        yield emit({
          type: 'error',
          payload: {
            code: 'cancelled',
            message: 'Ejecución cancelada antes de iniciar',
          },
        });
      } else {
        const briefFileName = `BRIEF-${task.id}.md`;
        const briefRelPath = `.orq/${briefFileName}`;
        const briefFullPath = join(ctx.worktreePath, '.orq', briefFileName);

        await mkdir(join(ctx.worktreePath, '.orq'), { recursive: true });
        await writeFile(briefFullPath, renderBrief(task, ctx.handoff), 'utf8');

        const args: string[] = [
          ...this.executable.args,
          '-p',
          `Lee el archivo ${briefRelPath} y cúmplelo.`,
          '--output-format',
          'stream-json',
          '--dangerously-skip-permissions',
        ];

        if (this.config.model) {
          args.push('--model', this.config.model);
        }

        for await (const line of this.runner({
          command: this.executable.command,
          args,
          cwd: ctx.worktreePath,
          env: ctx.env,
          signal: ctx.signal,
          timeoutMs: ctx.timeoutMs,
        })) {
          if (line.kind === 'exit') {
            exited = true;
            if (line.code !== 0 || line.aborted || line.timedOut) {
              if (!failed || line.aborted || line.timedOut) {
                yield emit({
                  type: 'error',
                  payload: {
                    code: line.aborted ? 'cancelled' : line.timedOut ? 'timeout' : 'crash',
                    message: `agy terminó con código ${String(line.code)}`,
                  },
                });
              }
              failed = true;
            }
          } else if (line.kind === 'json') {
            const events = translateAgyEvent(line.value, line.line).map((event) =>
              relativizeChange(event, ctx.worktreePath),
            );
            for (const event of events) {
              if (event.type === 'error') {
                failed = true;
              }
              if (event.type === 'done') {
                completed = true;
                resultDone = event.payload;
                continue;
              }
              yield emit(event);
            }
          } else if (line.kind === 'stderr') {
            const code = fatalLineCode(line.line);
            if (code) {
              failed = true;
              yield emit({ type: 'error', payload: { code, message: line.line } });
            } else {
              yield emit({ type: 'raw', payload: { source: 'agy-stderr', line: line.line } });
            }
          } else if (line.kind === 'text') {
            const code = fatalLineCode(line.line);
            if (code) {
              failed = true;
              yield emit({ type: 'error', payload: { code, message: line.line } });
            } else {
              yield emit({ type: 'raw', payload: { source: 'agy-cli', line: line.line } });
            }
          }
        }

        if (!failed && (!completed || !exited)) {
          failed = true;
          yield emit({
            type: 'error',
            payload: {
              code: 'invalid_output',
              message: 'agy terminó sin confirmar el resultado',
            },
          });
        }
      }
    } catch (err) {
      failed = true;
      yield emit({
        type: 'error',
        payload: {
          code: 'crash',
          message: err instanceof Error ? err.message : 'No se pudo ejecutar agy',
        },
      });
    }

    const ok = !failed && (resultDone?.ok ?? false);
    yield emit({ type: 'done', payload: { ok, ...(resultDone?.summary ? { summary: resultDone.summary } : {}) } });
  }
}
