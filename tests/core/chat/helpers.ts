/** Banco de pruebas del chat: SQLite en memoria, hub real, traductor real (c1), puertos falsos y `query` falsa del SDK. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkTranslator, estimateCostUsd } from '../../../src/core/adapters/claude-sdk/index.ts';
import { AttachmentStore, ChatService, type ChatServiceDeps, type MindPort } from '../../../src/core/chat/index.ts';
import type { ConductorQueryFn } from '../../../src/core/conductor/index.ts';
import { EventHub, type HubMessage } from '../../../src/core/server/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { DEFAULT_SETTINGS, agentConfigSchema } from '../../../src/shared/index.ts';
import type { AgentConfig, AgentEvent, Settings } from '../../../src/shared/index.ts';
import { fakePorts, type FakePorts } from '../conductor/fakes.ts';

export const MIND_KEY = `sk-ant-api03-${'M'.repeat(40)}`;

export const claudeAgent: AgentConfig = agentConfigSchema.parse({
  id: 'claude',
  kind: 'claude-sdk',
  provider: 'anthropic',
  displayName: 'Claude',
  secretRef: 'claude-key',
  model: 'claude-opus-5-5',
});

let n = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`;

export function sdkInit(sessionId: string): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', uuid: uuid() } as unknown as SDKMessage;
}

export function sdkText(text: string, sessionId: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    parent_tool_use_id: parentToolUseId,
    uuid: uuid(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** Mensaje del asistente a mitad de turno con el gasto acumulado del proceso (`usage_report`, como el SDK). */
export function sdkSpent(text: string, sessionId: string, totalCostUsd: number): SDKMessage {
  const m = sdkText(text, sessionId) as unknown as Record<string, unknown>;
  return { ...m, usage_report: { session: { total_cost_usd: totalCostUsd } } } as unknown as SDKMessage;
}

/** Resultado de un turno con costo acumulado (como el SDK en una conversación larga). */
export function sdkResult(text: string | undefined, sessionId: string, costUsd: number, subtype = 'success'): SDKMessage {
  return {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    ...(text !== undefined ? { result: text } : {}),
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: costUsd,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: Math.round(costUsd * 1000), outputTokens: Math.round(costUsd * 100), costUSD: costUsd } },
    permission_denials: [],
    uuid: uuid(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

export interface TurnContext {
  /** Turno dentro de este proceso del SDK. */
  index: number;
  /** Proceso del SDK (1, 2…): cada `query` nueva es una sesión nueva o reanudada. */
  process: number;
  options: Options;
  /** Se resuelve al interrumpir o cerrar. */
  stopped: Promise<void>;
}

/** Lo que entrega un turno: mensajes del SDK en orden y, si el proceso muere, el error con que lo hace (el stream lanza ahí). */
export type TurnOutput = SDKMessage | Error;

/** Guion de un turno: los mensajes de una vez, o un iterable asíncrono que puede esperar a mitad de turno. */
export type TurnFn = (message: SDKUserMessage, ctx: TurnContext) => Promise<TurnOutput[]> | TurnOutput[] | AsyncIterable<TurnOutput>;

export interface ChatQuery {
  fn: ConductorQueryFn;
  calls: { options: Options }[];
  received: SDKUserMessage[];
  closed: number;
  interrupted: number;
  /** Llamadas a `applyFlagSettings` por proceso del SDK (solo con `flags: true`). */
  flags: { process: number; settings: Record<string, unknown> }[];
}

/**
 * `query` falsa del SDK: un guion por mensaje; `interrupt()` y `close()` resuelven `ctx.stopped`. Con `flags`, el
 * stream tiene `applyFlagSettings` (cambia el esfuerzo en vivo, como `Query` del SDK).
 */
export function chatQuery(turn: TurnFn, opts: { flags?: boolean } = {}): ChatQuery {
  const state: ChatQuery = { fn: () => { throw new Error('sin iniciar'); }, calls: [], received: [], closed: 0, interrupted: 0, flags: [] };
  state.fn = ({ prompt, options }) => {
    state.calls.push({ options });
    const process = state.calls.length;
    let stop: () => void = () => undefined;
    let stopped = new Promise<void>((r) => { stop = r; });
    const stream = (async function* () {
      let index = 0;
      for await (const message of prompt) {
        state.received.push(message);
        const out = await turn(message, { index: index++, process, options, stopped });
        for await (const m of out) {
          if (m instanceof Error) throw m;
          yield m;
        }
        stopped = new Promise<void>((r) => { stop = r; });
      }
    })();
    return Object.assign(stream, {
      close: () => { state.closed++; stop(); },
      interrupt: async () => { state.interrupted++; stop(); },
      ...(opts.flags ? { applyFlagSettings: async (settings: Record<string, unknown>) => { state.flags.push({ process, settings }); } } : {}),
    });
  };
  return state;
}

/** Eco: init (en el primer turno de cada proceso), texto, resultado con costo acumulado 0,01 × turno. */
export const echoTurn: TurnFn = (message, ctx) => {
  const sid = typeof ctx.options.resume === 'string' ? ctx.options.resume : `sdk-${ctx.process}`;
  const content = message.message.content;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return [...(ctx.index === 0 ? [sdkInit(sid)] : []), sdkText(`eco: ${text}`, sid), sdkResult(`eco: ${text}`, sid, 0.01 * (ctx.index + 1))];
};

/** Uso de un turno con la caché repartida (como la API directa): el traductor lo toma tal cual, sin estimarlo. */
export interface TurnUsage {
  input: number;
  cached: number;
  output: number;
}

export const NO_USAGE: TurnUsage = { input: 0, cached: 0, output: 0 };

export function addUsage(...all: readonly TurnUsage[]): TurnUsage {
  return all.reduce((a, u) => ({ input: a.input + u.input, cached: a.cached + u.cached, output: a.output + u.output }), NO_USAGE);
}

/** Costo de un uso con los precios de pricing.ts, con el modelo de la mente de prueba. */
export function usageCost(u: TurnUsage): number {
  return estimateCostUsd('claude-opus-5-5', { input: u.input, output: u.output, cacheRead: u.cached, cacheWrite: 0 });
}

/** Guion de un proceso del SDK: lo que restaura Claude Code al reanudar y lo que gasta cada turno (`null`: no llama a la API). */
export interface MeteredProcess {
  restored?: TurnUsage;
  turns: readonly (TurnUsage | null)[];
}

/**
 * Turnos con uso coherente, como el SDK real: cada `result` trae el acumulado de la sesión. Al reanudar, Claude Code
 * restaura un acumulado anterior (una foto que puede ser vieja) y le suma el `usage` de los mensajes del proceso.
 */
export function meteredTurn(plan: readonly MeteredProcess[]): TurnFn {
  return (_message, ctx) => {
    const step = plan[ctx.process - 1];
    if (!step) throw new Error(`proceso ${ctx.process} sin guion`);
    const sid = typeof ctx.options.resume === 'string' ? ctx.options.resume : `sdk-${ctx.process}`;
    const own = step.turns[ctx.index] ?? null;
    const total = addUsage(step.restored ?? NO_USAGE, ...step.turns.slice(0, ctx.index + 1).filter((u): u is TurnUsage => u !== null));
    const out: SDKMessage[] = ctx.index === 0 ? [sdkInit(sid)] : [];
    if (own) {
      out.push({
        type: 'assistant',
        message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'eco' }], stop_reason: 'end_turn', usage: { input_tokens: own.input, cache_read_input_tokens: own.cached, output_tokens: own.output } },
        parent_tool_use_id: null,
        uuid: uuid(),
        session_id: sid,
      } as unknown as SDKMessage);
    }
    const cost = usageCost(total);
    const modelUsage = { 'claude-opus-5-5': { inputTokens: total.input, cacheReadInputTokens: total.cached, outputTokens: total.output, costUSD: cost } };
    out.push({ ...sdkResult(own ? 'eco' : '', sid, cost), modelUsage } as unknown as SDKMessage);
    return out;
  };
}

/**
 * Proceso del SDK que termina con un `result` de error (`errors`) y luego lanza, como el SDK real: primero lo dice por
 * stderr (si se pasa `stderr`), entrega el `result` con el id pedido y después el proceso muere.
 */
export function sdkErrorExit(sessionId: string, error: string, ctx: TurnContext, stderr?: string): TurnOutput[] {
  if (stderr !== undefined) ctx.options.stderr?.(`${stderr}\n`);
  const result = { ...sdkResult(undefined, sessionId, 0, 'error_during_execution'), errors: [error], modelUsage: {} } as unknown as SDKMessage;
  return [result, new Error(`Claude Code returned an error result: ${error}`)];
}

/** Reanudar una sesión cuya transcripción ya no existe, como lo hace el SDK real (stderr, `result` de error y error). */
export function sdkLostResume(sessionId: string, ctx: TurnContext): TurnOutput[] {
  const text = `No conversation found with session ID: ${sessionId}`;
  return sdkErrorExit(sessionId, text, ctx, text);
}

export interface ChatBench {
  dir: string;
  repo: string;
  store: SqliteStore;
  hub: EventHub;
  published: HubMessage[];
  ports: FakePorts;
  q: ChatQuery;
  attachments: AttachmentStore;
  service: ChatService;
  settings: { value: Settings };
  agents: AgentConfig[];
  envCalls: string[];
  /** Mensajes del hub de un tipo. */
  sent<T extends HubMessage['type']>(type: T): Extract<HubMessage, { type: T }>[];
  events(sessionId: string): AgentEvent[];
  /** Espera a que el chat deje de estar `running`. */
  settle(chatId: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface BenchOptions extends Partial<Omit<ChatServiceDeps, 'db' | 'store' | 'hub' | 'settings' | 'mind' | 'ports' | 'translator' | 'attachments'>> {
  turn?: TurnFn;
  /** La `query` falsa tiene `applyFlagSettings` (esfuerzo en vivo). */
  flags?: boolean;
  settings?: Settings;
  agents?: AgentConfig[];
  budgetLeftUsd?: (agentId: string) => number | undefined;
  /** Plugins vivos de la mente (`MindPort.plugins` y `pluginLive`). */
  plugins?: MindPort['plugins'];
  pluginLive?: MindPort['pluginLive'];
  liveSpend?: MindPort['liveSpend'];
}

const benches: ChatBench[] = [];

export async function bench(opts: BenchOptions = {}): Promise<ChatBench> {
  const dir = await mkdtemp(join(tmpdir(), 'orq-chat-'));
  const repo = join(dir, 'repo');
  await mkdir(repo, { recursive: true });
  const store = new SqliteStore({ path: ':memory:' });
  store.putProject({ id: 'demo', name: 'Demo', repoPath: repo });
  const hub = new EventHub(store);
  const published: HubMessage[] = [];
  hub.subscribe((m) => published.push(m));
  const ports = fakePorts();
  const q = chatQuery(opts.turn ?? echoTurn, { flags: opts.flags ?? false });
  const attachments = new AttachmentStore({ db: store.database, dir: join(dir, 'datos', 'attachments') });
  const settings = { value: opts.settings ?? DEFAULT_SETTINGS };
  const agents = opts.agents ?? [claudeAgent];
  const envCalls: string[] = [];
  const { turn: _turn, settings: _s, agents: _a, budgetLeftUsd, liveSpend, flags: _f, plugins, pluginLive, ...rest } = opts;
  const service = new ChatService({
    db: store.database,
    store,
    hub,
    settings: () => settings.value,
    mind: {
      agents: () => agents,
      env: async (agentId) => {
        envCalls.push(agentId);
        return { ANTHROPIC_API_KEY: MIND_KEY };
      },
      baseEnv: () => ({ PATH: 'C:\\Windows' }),
      ...(budgetLeftUsd ? { budgetLeftUsd } : {}),
      ...(plugins ? { plugins } : {}),
      ...(pluginLive ? { pluginLive } : {}),
      ...(liveSpend ? { liveSpend } : {}),
    },
    ports: { planner: ports.planner, fleet: ports.fleet, quotas: ports.quotas, memory: ports.memory, skills: ports.skills },
    translator: (init) => new ClaudeSdkTranslator(init),
    attachments,
    query: q.fn,
    drives: () => ['C:\\', 'D:\\'],
    ...rest,
  });
  const b: ChatBench = {
    dir,
    repo,
    store,
    hub,
    published,
    ports,
    q,
    attachments,
    service,
    settings,
    agents,
    envCalls,
    sent: (type) => published.filter((m): m is Extract<HubMessage, { type: typeof type }> => m.type === type),
    events: (sessionId) => store.eventsSince(sessionId, -1, 5000),
    settle: (chatId, timeoutMs = 5_000) => settleChat(service, chatId, timeoutMs),
    async close() {
      service.shutdown();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  benches.push(b);
  return b;
}

export async function closeBenches(): Promise<void> {
  for (const b of benches.splice(0)) await b.close();
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a que el chat salga de `running`, con plazo en tiempo (no en vueltas): al vencer lanza un error que nombra la
 * espera, antes que el «Test timed out» de 60 s. 15 s por defecto, para la CPU cargada del gate.
 */
export async function settleChat(service: Pick<ChatService, 'get'>, chatId: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (service.get(chatId).state === 'running') {
    if (Date.now() - t0 > timeoutMs) throw new Error(`el chat ${chatId} sigue running tras ${timeoutMs} ms`);
    await tick();
  }
  // Deja correr lo que quede del lector (mensaje de la mente, costo).
  await tick();
}

/** Bytes mínimos con firma real de cada formato. */
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
export const GIF = new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000');
export const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
