import type { AgentEvent } from '../../shared/index.ts';
import { estimateCostUsd } from '../adapters/claude-sdk/pricing.ts';
import type { OwnModelUsage } from './ports.ts';

type Totals = { input: number; output: number; cached: number; cacheWrite: number; reasoning: number; cost: number };
type UsagePayload = Extract<AgentEvent, { type: 'usage' }>['payload'];

const ZERO: Totals = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
const minus = (a: number, b: number) => Math.max(0, a - b);

export interface UsageDeltasOptions {
  /** Uso propio del proceso por modelo (`ConductorSession.ownUsage`). Solo para una sesión reanudada con `resume`. */
  own?: () => Readonly<Record<string, OwnModelUsage>>;
}

/**
 * `modelUsage` y `total_cost_usd` del SDK son acumulados de la sesión (cada `result` trae el total hasta ahora). Para
 * no sumarlos dos veces en SQLite, cada evento `usage` se guarda como diferencia con el anterior del mismo modelo. Usa
 * una función por proceso del SDK. Un proceso nuevo cuenta desde cero. Uno reanudado (`own`) no: Claude Code restaura
 * los acumulados de la sesión (a veces de una foto anterior al último proceso), así que en el primer evento de cada
 * modelo se fija como base lo restaurado (acumulado − uso propio) y desde ahí se mide contra ella.
 */
export function usageDeltas(opts: UsageDeltasOptions = {}): (event: AgentEvent) => AgentEvent | undefined {
  const prev = new Map<string, Totals>();
  const bases = new Map<string, Totals>();
  return (event) => {
    if (event.type !== 'usage') return event;
    const u = event.payload;
    const key = `${event.sessionId}\u0000${u.model ?? ''}`;
    const total = totalsOf(u);
    const base = bases.get(key) ?? (opts.own ? restoredBase(total, u.model, opts.own()) : ZERO);
    bases.set(key, base);
    const now = since(total, base);
    const before = prev.get(key) ?? ZERO;
    prev.set(key, now);
    if (minus(now.input, before.input) + minus(now.output, before.output) === 0 && minus(now.cost, before.cost) === 0) return undefined;
    return {
      ...event,
      payload: {
        ...u,
        inputTokens: minus(now.input, before.input),
        outputTokens: minus(now.output, before.output),
        ...(u.cachedInputTokens !== undefined ? { cachedInputTokens: minus(now.cached, before.cached) } : {}),
        ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: minus(now.cacheWrite, before.cacheWrite) } : {}),
        ...(u.reasoningTokens !== undefined ? { reasoningTokens: minus(now.reasoning, before.reasoning) } : {}),
        ...(u.costUsd !== undefined ? { costUsd: Math.round(minus(now.cost, before.cost) * 1e9) / 1e9 } : {}),
      },
    };
  };
}

function totalsOf(u: UsagePayload): Totals {
  return {
    input: u.inputTokens,
    output: u.outputTokens,
    cached: u.cachedInputTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0,
    cost: u.costUsd ?? 0,
  };
}

function since(total: Totals, base: Totals): Totals {
  return {
    input: minus(total.input, base.input),
    output: minus(total.output, base.output),
    cached: minus(total.cached, base.cached),
    cacheWrite: minus(total.cacheWrite, base.cacheWrite),
    reasoning: minus(total.reasoning, base.reasoning),
    cost: minus(total.cost, base.cost),
  };
}

/**
 * Lo que trajo restaurado un proceso reanudado: el acumulado menos el uso propio, contador por contador. El costo y el
 * razonamiento (que los mensajes no desglosan) se reparten según el peso del uso propio en el costo estimado con
 * pricing.ts, así no importa si sus precios difieren de los del SDK. Un modelo sin uso propio es todo restaurado.
 */
function restoredBase(total: Totals, model: string | undefined, own: Readonly<Record<string, OwnModelUsage>>): Totals {
  const mine = model !== undefined ? own[model] : sumOwn(Object.values(own));
  if (!mine) return total;
  const estimated = estimateCostUsd(model, {
    input: minus(total.input, total.cached + total.cacheWrite),
    output: total.output,
    cacheRead: total.cached,
    cacheWrite: total.cacheWrite,
  });
  const share = estimated > 0 ? Math.min(1, mine.cost / estimated) : mine.cost > 0 ? 1 : 0;
  return {
    input: minus(total.input, mine.input + mine.cacheRead + mine.cacheWrite),
    output: minus(total.output, mine.output),
    cached: minus(total.cached, mine.cacheRead),
    cacheWrite: minus(total.cacheWrite, mine.cacheWrite),
    reasoning: Math.round(total.reasoning * (1 - share)),
    cost: total.cost * (1 - share),
  };
}

function sumOwn(all: readonly OwnModelUsage[]): OwnModelUsage | undefined {
  if (!all.length) return undefined;
  return all.reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost }));
}
