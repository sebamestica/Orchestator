import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentAdapter,
  AgentConfig,
  AgentEvent,
  ErrorCode,
  EventSink,
  IntegrationResult,
  MemoryStore,
  ProbeResult,
  QuotaProvider,
  QuotaSnapshot,
  RunContext,
  SessionSummary,
  TaskBrief,
  Workspace,
  WorkspaceManager,
} from '../../../src/shared/index.ts';
import { agentConfigSchema, agentEventSchema, quotaSnapshotSchema, taskBriefSchema } from '../../../src/shared/index.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

export const agents = {
  claude1: agentConfigSchema.parse({ id: 'claude-1', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Claude 1' }),
  claude2: agentConfigSchema.parse({ id: 'claude-2', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Claude 2' }),
  codex: agentConfigSchema.parse({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' }),
  agy: agentConfigSchema.parse({ id: 'agy', kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity' }),
  api: agentConfigSchema.parse({ id: 'openrouter', kind: 'api', provider: 'openrouter', displayName: 'OpenRouter' }),
} satisfies Record<string, AgentConfig>;

export function task(id: string, extra: Partial<TaskBrief> = {}): TaskBrief {
  return taskBriefSchema.parse({
    id,
    projectId: 'demo',
    title: `Tarea ${id}`,
    objective: `Implementar ${id}`,
    ownedPaths: [`src/${id}/**`],
    dependsOn: [],
    acceptance: ['pruebas en verde'],
    difficulty: 'low',
    ...extra,
  });
}

// ---------------------------------------------------------------- adaptadores guionados

export type Step =
  | { text: string }
  | { file: string; change?: 'add' | 'modify' | 'delete' }
  | { usage: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { error: ErrorCode; message?: string }
  | { done: boolean; summary?: string }
  | { wait: number }
  /** Se queda colgado para siempre e ignora la señal (adaptador defectuoso). */
  | { hang: true }
  /** Espera a que se aborte la señal y sigue con el guion (adaptador que coopera). */
  | { untilAbort: true }
  /** Evento que no cumple el esquema. */
  | { invalid: unknown }
  /** Efecto lateral en el worktree (p. ej. escribir `.orq/HANDOFF.md`). */
  | { effect: (ctx: RunContext) => Promise<void> | void };

export type Script = readonly Step[] | ((task: TaskBrief, ctx: RunContext, call: number) => readonly Step[]);

/** Lleva la cuenta de ejecuciones simultáneas de todos los adaptadores que la comparten. */
export class ConcurrencyTracker {
  active = 0;
  max = 0;
  readonly log: string[] = [];
  enter(label: string): void {
    this.active++;
    this.max = Math.max(this.max, this.active);
    this.log.push(`+${label}`);
  }
  leave(label: string): void {
    this.active--;
    this.log.push(`-${label}`);
  }
}

/** Orden global de las llamadas a todos los adaptadores guionados. */
let callOrder = 0;

export interface ScriptedCall {
  task: TaskBrief;
  ctx: RunContext;
  agentId: string;
  order: number;
}

export class ScriptedAdapter implements AgentAdapter {
  readonly config: AgentConfig;
  readonly calls: ScriptedCall[] = [];
  readonly #scripts: Script[];
  readonly #tracker: ConcurrencyTracker | undefined;

  /** Un guion por llamada; la última se repite. */
  constructor(config: AgentConfig, scripts: Script | Script[], tracker?: ConcurrencyTracker) {
    this.config = config;
    this.#scripts = Array.isArray(scripts) && (scripts.length === 0 || isScript(scripts[0])) ? (scripts as Script[]) : [scripts as Script];
    this.#tracker = tracker;
  }

  async probe(): Promise<ProbeResult> {
    return { agentId: this.config.id, installed: true, authenticated: true, models: [], quotaMethod: 'none', warnings: [] };
  }

  async *run(task: TaskBrief, ctx: RunContext): AsyncGenerator<AgentEvent> {
    const call = this.calls.length;
    this.calls.push({ task, ctx, agentId: this.config.id, order: callOrder++ });
    const script = this.#scripts[Math.min(call, this.#scripts.length - 1)] ?? [];
    const steps = typeof script === 'function' ? script(task, ctx, call) : script;
    const sessionId = `${this.config.id}-s${call + 1}`;
    let seq = 0;
    const ev = (body: Record<string, unknown>): AgentEvent =>
      agentEventSchema.parse({ sessionId, agentId: this.config.id, seq: seq++, ts: new Date().toISOString(), ...body });
    const label = `${this.config.id}:${task.id}`;
    this.#tracker?.enter(label);
    try {
      yield ev({ type: 'status', payload: { state: 'starting' } });
      for (const step of steps) {
        if ('text' in step) yield ev({ type: 'text', payload: { text: step.text, role: 'assistant' } });
        else if ('file' in step) yield ev({ type: 'file_change', payload: { path: step.file, change: step.change ?? 'modify' } });
        else if ('usage' in step) yield ev({ type: 'usage', payload: step.usage });
        else if ('error' in step) yield ev({ type: 'error', payload: { code: step.error, message: step.message ?? step.error } });
        else if ('done' in step) yield ev({ type: 'done', payload: step.summary ? { ok: step.done, summary: step.summary } : { ok: step.done } });
        else if ('wait' in step) await delay(step.wait);
        else if ('hang' in step) await new Promise<never>(() => undefined);
        else if ('untilAbort' in step) await untilAbort(ctx.signal);
        else if ('invalid' in step) yield step.invalid as AgentEvent;
        else await step.effect(ctx);
      }
    } finally {
      this.#tracker?.leave(label);
    }
  }
}

function isScript(value: unknown): value is Script {
  return typeof value === 'function' || Array.isArray(value);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function untilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Guion de un autor que termina bien. */
export function okScript(summary = 'hecho', file?: string): Step[] {
  return [{ text: `Trabajando: ${summary}` }, ...(file ? [{ file }] : []), { usage: { inputTokens: 100, outputTokens: 10 } }, { done: true, summary }];
}

/** Guion de un revisor. */
export function verdictScript(veredicto: 'aprobado' | 'rechazado', observaciones: string[] = []): Step[] {
  return [
    { text: 'Revisé git diff y las pruebas.' },
    { text: `Conclusión.\n${JSON.stringify({ veredicto, observaciones })}` },
    { done: true },
  ];
}

// ---------------------------------------------------------------- cupo

export class FakeQuota implements QuotaProvider {
  readonly agentId: string;
  fraction: number | null;
  stale = false;
  failWith: string | undefined;
  takenAt: (() => string) | undefined;
  reads = 0;

  constructor(agentId: string, fraction: number | null) {
    this.agentId = agentId;
    this.fraction = fraction;
  }

  async read(): Promise<QuotaSnapshot> {
    this.reads++;
    if (this.failWith) throw new Error(this.failWith);
    return quotaSnapshotSchema.parse({
      agentId: this.agentId,
      method: 'none',
      takenAt: this.takenAt?.() ?? new Date().toISOString(),
      stale: this.stale,
      buckets: [
        { groupId: 'g', groupName: 'modelos', window: 'weekly', remainingFraction: this.fraction === null ? null : Math.min(1, this.fraction + 0.3) },
        { groupId: 'g', groupName: 'modelos', window: '5h', remainingFraction: this.fraction },
      ],
    });
  }
}

/** Cupo real de agy grabado en `fixtures/agy/usage.json` (salida de `agy -p "/usage" --output-format json`). */
export async function agyFixtureQuota(): Promise<QuotaProvider> {
  const raw: unknown = JSON.parse(await readFile(join(FIXTURES, 'agy', 'usage.json'), 'utf8'));
  const data = raw as { command: { data: { groups: { name: string; buckets: { id: string; window: string; remaining_fraction: number; reset_time: string }[] }[] } } };
  const snapshot = quotaSnapshotSchema.parse({
    agentId: 'agy',
    method: 'agy-usage',
    takenAt: new Date().toISOString(),
    stale: false,
    buckets: data.command.data.groups.flatMap((g) =>
      g.buckets.map((b) => ({ groupId: b.id, groupName: g.name, window: b.window, remainingFraction: b.remaining_fraction, resetAt: b.reset_time })),
    ),
  });
  return { agentId: 'agy', read: async () => snapshot };
}

/** Consumo real de un `codex exec --json` grabado en `fixtures/codex/exec-ok.jsonl`. */
export async function codexFixtureUsage(): Promise<{ inputTokens: number; outputTokens: number }> {
  const lines = (await readFile(join(FIXTURES, 'codex', 'exec-ok.jsonl'), 'utf8')).split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const value = JSON.parse(line) as { type?: string; usage?: { input_tokens: number; output_tokens: number } };
    if (value.type === 'turn.completed' && value.usage) return { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens };
  }
  throw new Error('fixture sin turn.completed');
}

// ---------------------------------------------------------------- servicios inyectados

export class MemorySink implements EventSink {
  readonly events: AgentEvent[] = [];
  append(event: AgentEvent): void {
    this.events.push(event);
  }
  of(agentId: string): AgentEvent[] {
    return this.events.filter((e) => e.agentId === agentId);
  }
}

export class FakeMemory implements MemoryStore {
  readonly sessions: SessionSummary[] = [];
  readonly contextRequests: { projectId: string; taskId: string; budget: number }[] = [];
  async buildContext(projectId: string, t: TaskBrief, budgetChars: number): Promise<string> {
    this.contextRequests.push({ projectId, taskId: t.id, budget: budgetChars });
    return `Contexto de memoria para ${t.id}`;
  }
  async recordSession(summary: SessionSummary): Promise<void> {
    this.sessions.push(summary);
  }
}

/** Worktrees reales en una carpeta temporal; la integración sigue un guion por tarea (por defecto, ok). */
export class FakeWorkspaces implements WorkspaceManager {
  readonly root: string;
  readonly created: Workspace[] = [];
  readonly integrated: string[] = [];
  readonly removed: string[] = [];
  readonly integrationScript = new Map<string, IntegrationResult[]>();
  /** Se ejecuta dentro de `integrate`, antes de devolver el resultado (p. ej. para cancelar a mitad). */
  duringIntegrate: ((workspace: Workspace) => Promise<void> | void) | undefined;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(): Promise<FakeWorkspaces> {
    return new FakeWorkspaces(await mkdtemp(join(tmpdir(), 'orq-c2-')));
  }

  async create(projectId: string, t: TaskBrief): Promise<Workspace> {
    const path = join(this.root, projectId, t.id);
    await mkdir(path, { recursive: true });
    const ws = { taskId: t.id, path, branch: `orq/${t.id}` };
    this.created.push(ws);
    return ws;
  }

  async integrate(_projectId: string, workspace: Workspace): Promise<IntegrationResult> {
    await this.duringIntegrate?.(workspace);
    const next = this.integrationScript.get(workspace.taskId)?.shift();
    const result = next ?? { ok: true, conflicts: [], gateSummary: 'gate ok', commit: `c-${workspace.taskId}` };
    if (result.ok) this.integrated.push(workspace.taskId);
    return result;
  }

  async remove(workspace: Workspace): Promise<void> {
    this.removed.push(workspace.taskId);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export async function writeHandoffFile(ctx: RunContext, text: string): Promise<void> {
  await mkdir(join(ctx.worktreePath, '.orq'), { recursive: true });
  await writeFile(join(ctx.worktreePath, '.orq', 'HANDOFF.md'), text, 'utf8');
}
