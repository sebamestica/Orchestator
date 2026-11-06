/** Puertos falsos del orquestador para las pruebas (sin red ni CLIs). */
import { readFile } from 'node:fs/promises';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseAgyUsage } from '../../../src/core/quota/agy.ts';
import { CodexQuotaProvider } from '../../../src/core/quota/codex.ts';
import type {
  ConductorMemoryPort,
  ConductorPorts,
  DecisionNote,
  DelegateResult,
  FleetPort,
  FleetTaskStatus,
  PlannerPort,
  PlannerResult,
  PlanRequest,
  ProjectTaskStatus,
  QuotaPort,
  SkillCatalogPort,
  SkillInfo,
  ConductorQueryFn,
} from '../../../src/core/conductor/index.ts';
import { TaskProposals } from '../../../src/core/conductor/index.ts';
import type { QuotaSnapshot, TaskBrief } from '../../../src/shared/index.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

/** Secretos de prueba (no son claves reales): ninguno debe salir en una respuesta. */
export const FAKE_API_KEY = `sk-ant-api03-${'Q'.repeat(40)}`;
export const FAKE_OPENAI_KEY = `sk-proj-${'W'.repeat(30)}`;
export const SESSION_SECRET = 'secreto-de-sesion-9f8e7d6c';
export const SECRET_PATTERN = /sk-ant-api03|QQQQQQQQ|sk-proj-|WWWWWWWW|secreto-de-sesion/;

export const NOW = new Date('2026-11-01T22:30:00.000Z');

export function brief(id: string, extra: Partial<TaskBrief> = {}): TaskBrief {
  return taskBriefSchema.parse({
    id,
    projectId: 'demo',
    title: `Tarea ${id}`,
    objective: `Objetivo de ${id}`,
    ownedPaths: [`src/${id}/**`],
    dependsOn: [],
    acceptance: ['pruebas en verde'],
    difficulty: 'medium',
    ...extra,
  });
}

export class FakePlanner implements PlannerPort {
  readonly requests: PlanRequest[] = [];
  result: PlannerResult;
  constructor(result: PlannerResult) {
    this.result = result;
  }
  async plan(request: PlanRequest): Promise<PlannerResult> {
    this.requests.push(request);
    return this.result;
  }
}

/** Flota falsa: como los puertos del núcleo (`withTaskProjects`), cada estado lleva el proyecto de su tarea. */
export class FakeFleet implements FleetPort {
  readonly delegated: TaskBrief[] = [];
  readonly statuses = new Map<string, ProjectTaskStatus>();
  reject: string | undefined;
  async delegate(task: TaskBrief): Promise<DelegateResult> {
    if (this.reject) return { accepted: false, reason: this.reject };
    this.delegated.push(task);
    const agentId = task.suggestedAgent ?? 'claude-worker';
    this.statuses.set(task.id, { taskId: task.id, projectId: task.projectId, state: 'pending', agentId, updatedAt: NOW.toISOString() });
    return { accepted: true, agentId, state: 'pending' };
  }
  status(taskId: string): ProjectTaskStatus | undefined {
    return this.statuses.get(taskId);
  }
  list(): ProjectTaskStatus[] {
    return [...this.statuses.values()];
  }
  /** Simula el avance que harían cola y supervisor. */
  advance(taskId: string, state: FleetTaskStatus['state'], detail?: string): void {
    const current = this.statuses.get(taskId);
    if (!current) throw new Error(`sin tarea ${taskId}`);
    this.statuses.set(taskId, { ...current, state, detail, updatedAt: NOW.toISOString() });
  }
}

export class FakeQuotas implements QuotaPort {
  snapshots: QuotaSnapshot[];
  constructor(snapshots: QuotaSnapshot[] = []) {
    this.snapshots = snapshots;
  }
  all(): QuotaSnapshot[] {
    return this.snapshots;
  }
}

export class FakeMemory implements ConductorMemoryPort {
  readonly contexts: { projectId: string; task: TaskBrief; budget: number }[] = [];
  readonly decisions: DecisionNote[] = [];
  readonly summaries: { projectId: string; summary: string; at: string }[] = [];
  context = '';
  async buildContext(projectId: string, task: TaskBrief, budgetChars: number): Promise<string> {
    this.contexts.push({ projectId, task, budget: budgetChars });
    return this.context;
  }
  async recordDecision(input: DecisionNote): Promise<string> {
    this.decisions.push(input);
    return `Orquestador/Decisiones/${input.at.slice(0, 10)}-decision`;
  }
  async writeProjectSummary(projectId: string, summary: string, at: string): Promise<void> {
    this.summaries.push({ projectId, summary, at });
  }
}

export class FakeSkills implements SkillCatalogPort {
  skills: SkillInfo[];
  constructor(skills: SkillInfo[] = []) {
    this.skills = skills;
  }
  async list(): Promise<SkillInfo[]> {
    return this.skills;
  }
}

export interface FakePorts extends ConductorPorts {
  planner: FakePlanner;
  proposals: TaskProposals;
  fleet: FakeFleet;
  quotas: FakeQuotas;
  memory: FakeMemory;
  skills: FakeSkills;
}

export function fakePorts(overrides: Partial<FakePorts> = {}): FakePorts {
  return {
    planner: new FakePlanner({ ok: true, tasks: [brief('api'), brief('ui', { dependsOn: ['api'], suggestedAgent: 'codex' })] }),
    proposals: new TaskProposals({ now: () => NOW }),
    fleet: new FakeFleet(),
    quotas: new FakeQuotas(),
    memory: new FakeMemory(),
    skills: new FakeSkills(),
    ...overrides,
  };
}

/** Cupos reales de las fixtures: agy (`/usage`) y Codex (app-server). */
export async function fixtureQuotas(): Promise<QuotaSnapshot[]> {
  const agyRaw: unknown = JSON.parse(await readFile(new URL('../../../fixtures/agy/usage.json', import.meta.url), 'utf8'));
  const codexRaw: unknown = JSON.parse(await readFile(new URL('../../../fixtures/codex/app-server-synthetic.json', import.meta.url), 'utf8'));
  const agy = parseAgyUsage(agyRaw, 'agy', '2026-11-01T20:00:00Z');
  const codex = await new CodexQuotaProvider('codex', { readAppServer: async () => codexRaw }).read();
  return [agy, codex];
}

/** Texto de la primera parte de una respuesta de herramienta. */
export function textOf(result: { content: readonly unknown[] }): string {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') throw new Error('respuesta sin texto');
  return first.text;
}

export function jsonOf(result: { content: readonly unknown[] }): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

// ---------- mensajes del SDK y query falsos ----------


let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;

/** Forma mínima de los mensajes reales del SDK (los campos que leen el traductor y las pruebas). */
export function assistantMessage(content: unknown[]): SDKMessage {
  return {
    type: 'assistant',
    message: { id: `msg_${uuidCounter}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage;
}

export const assistantText = (text: string) => assistantMessage([{ type: 'text', text }]);
export const assistantToolUse = (id: string, name: string, input: unknown) => assistantMessage([{ type: 'tool_use', id, name, input }]);

export function toolResultMessage(toolUseId: string, text: string, isError = false): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }], is_error: isError }] },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage;
}

export function resultMessage(text: string): SDKMessage {
  return {
    type: 'result', subtype: 'success', result: text, is_error: false, num_turns: 1, duration_ms: 1, duration_api_ms: 1,
    stop_reason: 'end_turn', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {}, permission_denials: [],
    uuid: uuid(), session_id: 'sdk-session-1',
  } as unknown as SDKMessage;
}

export interface ScriptedQuery {
  fn: ConductorQueryFn;
  calls: { options: Options }[];
  received: SDKUserMessage[];
  closed: number;
  interrupted: number;
  /** Llamadas a `applyFlagSettings` (solo con la opción `flags`). */
  flags: Record<string, unknown>[];
}

/** `query` falsa: por cada mensaje del usuario ejecuta el guion y emite lo que devuelve. */
/**
 * `flags`: con `'ok'` o `'reject'`, el stream tiene `applyFlagSettings` (como `Query` del SDK) y anota cada llamada en
 * `state.flags`; sin la opción, no lo tiene (como un CLI antiguo).
 */
export function scriptedQuery(turn: (message: SDKUserMessage, index: number) => Promise<SDKMessage[]> | SDKMessage[], opts: { flags?: 'ok' | 'reject' } = {}): ScriptedQuery {
  const state: ScriptedQuery = { fn: () => { throw new Error('sin iniciar'); }, calls: [], received: [], closed: 0, interrupted: 0, flags: [] };
  state.fn = ({ prompt, options }) => {
    state.calls.push({ options });
    const stream = (async function* () {
      let index = 0;
      for await (const message of prompt) {
        state.received.push(message);
        for (const out of await turn(message, index++)) yield out;
      }
    })();
    const flags = opts.flags;
    return Object.assign(stream, {
      close: () => { state.closed++; },
      interrupt: async () => { state.interrupted++; },
      ...(flags
        ? {
            applyFlagSettings: async (settings: Record<string, unknown>) => {
              state.flags.push(settings);
              if (flags === 'reject') throw new Error('control request no admitido');
            },
          }
        : {}),
    });
  };
  return state;
}

/** Lee mensajes hasta el próximo `result` (fin de un turno). */
export async function readTurn<T extends { type: string }>(iterator: AsyncIterator<T>): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return out;
    out.push(next.value);
    if (next.value.type === 'result' || next.value.type === 'done') return out;
  }
}

export function userText(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** Bloques del prompt de sistema de la mente: `{ type: 'custom', prompt: string[], snapshot: false }`. */
export function promptBlocks(options: Options | undefined): string[] {
  const prompt = options?.systemPrompt;
  if (typeof prompt !== 'object' || Array.isArray(prompt) || prompt.type !== 'custom' || !Array.isArray(prompt.prompt)) {
    throw new Error('systemPrompt no es un prompt propio en bloques');
  }
  return prompt.prompt;
}
