/**
 * Resumen de uso y gasto (issue 5): lee `usage` (con la carga de su evento para la caché escrita), `sessions`,
 * `tasks`, `chat_chats`, `agents`, `projects` y las fotos de cupo. Solo lectura sobre las tablas del núcleo.
 *
 * Tokens en la convención normalizada (`usageSchema`): entrada nueva + caché escrita + caché leída + salida. Los
 * registros anteriores al issue 5 (sin `cacheWriteTokens` en su evento) se leen según su agente: agy guardaba la
 * entrada sin la caché; Claude y Codex, con la caché leída dentro (la escrita no se conoce y queda en la entrada nueva).
 *
 * Costo: «estimado» = el `costUsd` registrado (SDK de Claude o adaptador, con precios públicos); «con tu tarifa» =
 * estimado × el multiplicador del modelo (`UsageRates`). Codex y agy son de suscripción: tokens y cupo, sin costo.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  MAX_USAGE_RANGE_DAYS,
  minRemainingFraction,
  usageRoleSchema,
  type AgentKind,
  type UsageBilling,
  type UsageBucket,
  type UsageModelRow,
  type UsagePeriod,
  type UsageRole,
  type UsageSplit,
  type UsageSubscriptionRow,
  type UsageSummary,
  type UsageSummaryQuery,
} from '../../shared/index.ts';
import type { SqliteStore } from '../store/index.ts';
import { addDays, dayCount, dayFormatter, eachDay, isRealDay, isValidTimeZone, maxDay, minDay, monthStart, systemTimeZone } from './dates.ts';
import { DEFAULT_MULTIPLIER, type UsageRates } from './rates.ts';

/** Agente de la mente (`CONDUCTOR_AGENT_ID` de src/core/conductor; se pasa desde `f5-uso.ts`). */
export const DEFAULT_MIND_AGENT_ID = 'orquestador';
/** Prefijo de las sesiones del planificador (`app/planner.ts`). */
export const PLANNER_SESSION_PREFIX = 'plan-';
const SUBSCRIPTION_KINDS: ReadonlySet<AgentKind> = new Set(['codex-cli', 'agy-cli']);
const ROLE_ORDER: readonly UsageRole[] = usageRoleSchema.options;

/** Lo que el resumen lee del almacén. */
export type UsageSource = Pick<SqliteStore, 'database' | 'listAgents' | 'listProjects' | 'latestQuotas'>;

export interface UsageStatsOptions {
  rates: UsageRates;
  /** Zona horaria por defecto de los días (la del núcleo). */
  timeZone?: string;
  now?: () => Date;
  mindAgentId?: string;
}

/** Consulta inválida (la ruta la traduce a 400). */
export class UsageStatsError extends Error {
  override readonly name = 'UsageStatsError';
}

// ------------------------------------------------------------------ filas

const count = z.union([z.number(), z.bigint()]).transform(Number);
const rawRowSchema = z.object({
  agent_id: z.string(),
  session_id: z.string(),
  model: z.string().nullable(),
  ts: z.string(),
  input_tokens: count,
  output_tokens: count,
  cached_input_tokens: count,
  reasoning_tokens: count,
  cost_usd: z.number().nullable(),
  // Ausente (NULL) en los eventos anteriores al issue 5; un valor raro se lee como ausente.
  cache_write: count.nullable().catch(null),
  task_id: z.string().nullable(),
});

interface UsageEntry {
  agentId: string;
  sessionId: string;
  model: string | null;
  /** Día en la zona horaria pedida. */
  day: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  cost: number | null;
  cacheWrite: number | null;
  taskId: string | null;
}

interface Tokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  reasoning: number;
}

/** Tokens separados de un registro, y si es anterior a la convención normalizada. */
export function normalizeTokens(
  e: Pick<UsageEntry, 'input' | 'output' | 'cached' | 'reasoning' | 'cacheWrite'>,
  kind: AgentKind | undefined,
): { tokens: Tokens; legacy: boolean } {
  const cacheRead = e.cached;
  if (e.cacheWrite !== null) {
    // Normalizado: lo leído y lo escrito van dentro de la entrada. Se acota por si un acumulado se coló como parte.
    const cacheWrite = Math.min(e.cacheWrite, Math.max(0, e.input - cacheRead));
    return { tokens: { input: Math.max(0, e.input - cacheRead - cacheWrite), cacheWrite, cacheRead, output: e.output, reasoning: e.reasoning }, legacy: false };
  }
  // Anterior: agy guardaba la entrada sin la caché (en sus datos lo leído supera a menudo a la entrada).
  const excludesCache = kind === 'agy-cli' || cacheRead > e.input;
  return { tokens: { input: excludesCache ? e.input : e.input - cacheRead, cacheWrite: 0, cacheRead, output: e.output, reasoning: e.reasoning }, legacy: true };
}

// --------------------------------------------------------------- sumas

interface Acc extends Tokens {
  cost: number;
  costWithRate: number;
  entries: number;
}
const emptyAcc = (): Acc => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0, costWithRate: 0, entries: 0 });
type SplitAcc = Record<UsageBilling, Acc>;
const emptySplit = (): SplitAcc => ({ api: emptyAcc(), subscription: emptyAcc() });

function add(acc: Acc, t: Tokens, cost: number, costWithRate: number): void {
  acc.input += t.input;
  acc.cacheWrite += t.cacheWrite;
  acc.cacheRead += t.cacheRead;
  acc.output += t.output;
  acc.reasoning += t.reasoning;
  acc.cost += cost;
  acc.costWithRate += costWithRate;
  acc.entries++;
}

const usd = (n: number): number => Math.round(n * 1e6) / 1e6;

function bucket(acc: Acc): UsageBucket {
  return {
    inputTokens: acc.input,
    cacheWriteTokens: acc.cacheWrite,
    cacheReadTokens: acc.cacheRead,
    outputTokens: acc.output,
    reasoningTokens: acc.reasoning,
    totalTokens: acc.input + acc.cacheWrite + acc.cacheRead + acc.output,
    costUsd: usd(acc.cost),
    costWithRateUsd: usd(acc.costWithRate),
    entries: acc.entries,
  };
}

const split = (s: SplitAcc): UsageSplit => ({ api: bucket(s.api), subscription: bucket(s.subscription) });

function getOr<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

// ------------------------------------------------------------- resumen

interface Range {
  from: string;
  to: string;
  period: UsagePeriod | null;
}

interface TaskInfo {
  projectId: string;
  /** Agentes autores conocidos: el de la tarea (el último autor) y el de su primera sesión. */
  authors: Set<string>;
}

const taskRowSchema = z.object({ id: z.string(), project_id: z.string(), agent_id: z.string().nullable(), first_agent: z.string().nullable() });
const chatRowSchema = z.object({ session_id: z.string(), project_id: z.string().nullable() });

export class UsageStats {
  readonly #store: UsageSource;
  readonly #db: DatabaseSync;
  readonly #rates: UsageRates;
  readonly #timeZone: string;
  readonly #now: () => Date;
  readonly #mindAgentId: string;

  constructor(store: UsageSource, opts: UsageStatsOptions) {
    this.#store = store;
    this.#db = store.database;
    this.#rates = opts.rates;
    this.#timeZone = opts.timeZone ?? systemTimeZone();
    this.#now = opts.now ?? (() => new Date());
    this.#mindAgentId = opts.mindAgentId ?? DEFAULT_MIND_AGENT_ID;
  }

  summary(query: UsageSummaryQuery = {}): UsageSummary {
    const timeZone = query.tz ?? this.#timeZone;
    if (!isValidTimeZone(timeZone)) throw new UsageStatsError('Zona horaria desconocida');
    const fmt = dayFormatter(timeZone);
    const today = fmt.format(this.#now());
    const range = resolveRange(query, today);
    const periods: Record<UsagePeriod, { from: string; to: string }> = {
      today: { from: today, to: today },
      week: { from: addDays(today, -6), to: today },
      month: { from: monthStart(today), to: today },
    };

    const entries = this.#load(range.from, range.to, fmt);
    const periodsFrom = minDay(periods.week.from, periods.month.from);
    const periodEntries = periodsFrom >= range.from && today <= range.to ? entries : this.#load(periodsFrom, today, fmt);

    const agents = this.#store.listAgents();
    const kinds = new Map(agents.map((a) => [a.config.id, a.config.kind]));
    const billingOf = (e: UsageEntry): UsageBilling => {
      if (e.agentId === this.#mindAgentId) return 'api';
      const kind = kinds.get(e.agentId);
      if (kind) return SUBSCRIPTION_KINDS.has(kind) ? 'subscription' : 'api';
      // Agente ya borrado: sin costo registrado se trata como suscripción.
      return e.cost === null ? 'subscription' : 'api';
    };
    const multipliers = this.#rates.multipliers();
    const priced = (e: UsageEntry, billing: UsageBilling): { cost: number; withRate: number; multiplier: number } => {
      if (billing === 'subscription') return { cost: 0, withRate: 0, multiplier: DEFAULT_MULTIPLIER };
      const multiplier = (e.model ? multipliers.get(e.model) : undefined) ?? DEFAULT_MULTIPLIER;
      const cost = e.cost ?? 0;
      return { cost, withRate: cost * multiplier, multiplier };
    };

    // Periodos fijos.
    const periodAcc: Record<UsagePeriod, SplitAcc> = { today: emptySplit(), week: emptySplit(), month: emptySplit() };
    for (const e of periodEntries) {
      const billing = billingOf(e);
      const { tokens } = normalizeTokens(e, kinds.get(e.agentId));
      const { cost, withRate } = priced(e, billing);
      for (const p of ['today', 'week', 'month'] as const) {
        if (e.day >= periods[p].from && e.day <= periods[p].to) add(periodAcc[p][billing], tokens, cost, withRate);
      }
    }

    // Rango pedido.
    const classify = this.#classifier(entries);
    const totals = emptySplit();
    const byDay = new Map(eachDay(range.from, range.to).map((d) => [d, emptySplit()]));
    const byRole = new Map<UsageRole, SplitAcc>();
    const byProject = new Map<string | null, SplitAcc>();
    const byModel = new Map<string, { acc: Acc; billing: UsageBilling; model: string | null; agents: Set<string>; multiplier: number; withoutCost: number }>();
    const subs = new Map<string, { acc: Acc; models: Set<string> }>();
    const coverage = { withoutCacheWrite: 0, withoutCost: 0, unlinked: 0 };

    for (const e of entries) {
      const billing = billingOf(e);
      const { tokens, legacy } = normalizeTokens(e, kinds.get(e.agentId));
      const { cost, withRate, multiplier } = priced(e, billing);
      const { role, projectId } = classify(e);
      add(totals[billing], tokens, cost, withRate);
      const day = byDay.get(e.day);
      if (day) add(day[billing], tokens, cost, withRate);
      add(getOr(byRole, role, emptySplit)[billing], tokens, cost, withRate);
      add(getOr(byProject, projectId, emptySplit)[billing], tokens, cost, withRate);
      const m = getOr(byModel, `${billing}\u0000${e.model ?? ''}`, () => ({ acc: emptyAcc(), billing, model: e.model, agents: new Set<string>(), multiplier, withoutCost: 0 }));
      add(m.acc, tokens, cost, withRate);
      m.agents.add(e.agentId);
      if (billing === 'subscription') {
        const s = getOr(subs, e.agentId, () => ({ acc: emptyAcc(), models: new Set<string>() }));
        add(s.acc, tokens, 0, 0);
        if (e.model) s.models.add(e.model);
      }
      if (billing === 'api' && legacy) coverage.withoutCacheWrite++;
      if (billing === 'api' && e.cost === null) {
        coverage.withoutCost++;
        m.withoutCost++;
      }
      if (role === 'other') coverage.unlinked++;
    }

    const projectNames = new Map(this.#store.listProjects().map((p) => [p.id, p.name]));
    const modelRows: UsageModelRow[] = [...byModel.values()]
      .map((m) => ({ ...bucket(m.acc), billing: m.billing, model: m.model, agentIds: [...m.agents].sort(), multiplier: m.multiplier, withoutCost: m.withoutCost }))
      .sort(
        (a, b) =>
          (a.billing === b.billing ? 0 : a.billing === 'api' ? -1 : 1) ||
          b.costWithRateUsd - a.costWithRateUsd ||
          b.totalTokens - a.totalTokens ||
          (a.model ?? '￿').localeCompare(b.model ?? '￿'),
      );

    return {
      currency: 'USD',
      timeZone,
      today,
      period: range.period,
      from: range.from,
      to: range.to,
      periods: {
        today: { ...periods.today, ...split(periodAcc.today) },
        week: { ...periods.week, ...split(periodAcc.week) },
        month: { ...periods.month, ...split(periodAcc.month) },
      },
      totals: split(totals),
      byModel: modelRows,
      byDay: [...byDay].map(([day, s]) => ({ day, ...split(s) })),
      byRole: ROLE_ORDER.filter((r) => byRole.has(r)).map((role) => ({ role, ...split(byRole.get(role) ?? emptySplit()) })),
      byProject: [...byProject]
        .map(([projectId, s]) => ({ projectId, name: projectId === null ? null : (projectNames.get(projectId) ?? null), ...split(s) }))
        .sort(
          (a, b) =>
            (a.projectId === null ? 1 : 0) - (b.projectId === null ? 1 : 0) ||
            b.api.costWithRateUsd - a.api.costWithRateUsd ||
            b.subscription.totalTokens - a.subscription.totalTokens ||
            (a.projectId ?? '').localeCompare(b.projectId ?? ''),
        ),
      subscriptions: this.#subscriptions(agents, subs),
      coverage,
    };
  }

  /** Registros de uso de `from` a `to` (días en la zona de `fmt`). */
  #load(from: string, to: string, fmt: Intl.DateTimeFormat): UsageEntry[] {
    // La columna `day` está en la zona del almacén: se lee con margen y se filtra por el día en la zona pedida.
    const rows = this.#db
      .prepare(
        `SELECT u.agent_id, u.session_id, u.model, u.ts, u.input_tokens, u.output_tokens, u.cached_input_tokens,
           u.reasoning_tokens, u.cost_usd, json_extract(e.payload_json, '$.cacheWriteTokens') AS cache_write, s.task_id
         FROM usage u
         LEFT JOIN events e ON e.id = u.event_id
         LEFT JOIN sessions s ON s.id = u.session_id
         WHERE u.day >= ? AND u.day <= ?
         ORDER BY u.ts, u.id`,
      )
      .all(addDays(from, -2), addDays(to, 2));
    const out: UsageEntry[] = [];
    for (const raw of rows) {
      const r = rawRowSchema.parse(raw);
      const at = new Date(r.ts);
      if (Number.isNaN(at.getTime())) continue;
      const day = fmt.format(at);
      if (day < from || day > to) continue;
      out.push({
        agentId: r.agent_id,
        sessionId: r.session_id,
        model: r.model,
        day,
        input: r.input_tokens,
        output: r.output_tokens,
        cached: r.cached_input_tokens,
        reasoning: r.reasoning_tokens,
        cost: r.cost_usd,
        cacheWrite: r.cache_write,
        taskId: r.task_id,
      });
    }
    return out;
  }

  /**
   * Rol y proyecto de cada sesión: la mente (su agente o la sesión de un chat), el autor o el revisor de una tarea
   * (el revisor nunca es autor: es revisor la sesión de un agente que no es el de la tarea ni el de su primera
   * sesión), el planificador (`plan-…`) u otros.
   */
  #classifier(entries: readonly UsageEntry[]): (e: UsageEntry) => { role: UsageRole; projectId: string | null } {
    const taskIds = [...new Set(entries.map((e) => e.taskId).filter((id): id is string => id !== null))];
    const tasks = new Map<string, TaskInfo>();
    if (taskIds.length > 0) {
      const rows = this.#db
        .prepare(
          `SELECT t.id, t.project_id, t.agent_id,
             (SELECT s.agent_id FROM sessions s WHERE s.task_id = t.id ORDER BY s.started_at, s.rowid LIMIT 1) AS first_agent
           FROM tasks t WHERE t.id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(taskIds));
      for (const raw of rows) {
        const t = taskRowSchema.parse(raw);
        tasks.set(t.id, { projectId: t.project_id, authors: new Set([t.agent_id, t.first_agent].filter((a): a is string => a !== null)) });
      }
    }
    const chats = this.#chatProjects();
    const cache = new Map<string, { role: UsageRole; projectId: string | null }>();
    return (e) =>
      getOr(cache, `${e.sessionId}\u0000${e.agentId}`, () => {
        if (e.agentId === this.#mindAgentId || chats.has(e.sessionId)) return { role: 'mind', projectId: chats.get(e.sessionId) ?? null };
        if (e.taskId) {
          const task = tasks.get(e.taskId);
          if (!task) return { role: 'author', projectId: null };
          return { role: task.authors.size === 0 || task.authors.has(e.agentId) ? 'author' : 'reviewer', projectId: task.projectId };
        }
        if (e.sessionId.startsWith(PLANNER_SESSION_PREFIX)) return { role: 'planner', projectId: null };
        return { role: 'other', projectId: null };
      });
  }

  /** Sesión de cada chat con la mente → su proyecto (la tabla es del módulo de chats; puede no existir). */
  #chatProjects(): Map<string, string | null> {
    const exists = this.#db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'chat_chats'`).get();
    if (!exists) return new Map();
    const out = new Map<string, string | null>();
    for (const raw of this.#db.prepare('SELECT session_id, project_id FROM chat_chats').all()) {
      const c = chatRowSchema.safeParse(raw);
      if (c.success) out.set(c.data.session_id, c.data.project_id);
    }
    return out;
  }

  /** Agentes de suscripción: los registrados (habilitados o con uso) y los borrados que tienen uso en el rango. */
  #subscriptions(agents: ReturnType<UsageSource['listAgents']>, subs: Map<string, { acc: Acc; models: Set<string> }>): UsageSubscriptionRow[] {
    const quotas = new Map(this.#store.latestQuotas().map((q) => [q.snapshot.agentId, q.snapshot]));
    const rows: UsageSubscriptionRow[] = [];
    const seen = new Set<string>();
    const push = (agentId: string, displayName: string, kind: AgentKind | null) => {
      seen.add(agentId);
      const s = subs.get(agentId);
      const quota = quotas.get(agentId);
      rows.push({
        ...bucket(s?.acc ?? emptyAcc()),
        agentId,
        displayName,
        kind,
        models: [...(s?.models ?? [])].sort(),
        quotaRemaining: quota ? minRemainingFraction(quota) : null,
        quotaTakenAt: quota?.takenAt ?? null,
        quotaStale: quota?.stale ?? false,
      });
    };
    for (const a of agents) {
      if (SUBSCRIPTION_KINDS.has(a.config.kind) && (a.config.enabled || subs.has(a.config.id))) push(a.config.id, a.config.displayName, a.config.kind);
    }
    for (const agentId of [...subs.keys()].sort()) if (!seen.has(agentId)) push(agentId, agentId, null);
    return rows.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }
}

/** Rango del resumen: `from`/`to` (o uno de ellos) o un periodo fijo; por defecto el mes calendario. */
export function resolveRange(query: UsageSummaryQuery, today: string): Range {
  const custom = query.from !== undefined || query.to !== undefined;
  if (custom && query.period !== undefined) throw new UsageStatsError('Usa period o from/to, no ambos');
  let range: Range;
  if (custom) {
    const from = query.from ?? query.to ?? today;
    const to = query.to ?? maxDay(today, from);
    range = { from, to, period: null };
  } else {
    const period = query.period ?? 'month';
    const from = period === 'today' ? today : period === 'week' ? addDays(today, -6) : monthStart(today);
    range = { from, to: today, period };
  }
  if (!isRealDay(range.from) || !isRealDay(range.to)) throw new UsageStatsError('Fecha inexistente: usa AAAA-MM-DD');
  if (range.from > range.to) throw new UsageStatsError('from no puede ser posterior a to');
  if (dayCount(range.from, range.to) > MAX_USAGE_RANGE_DAYS) throw new UsageStatsError(`El rango va de 1 a ${MAX_USAGE_RANGE_DAYS} días`);
  return range;
}
