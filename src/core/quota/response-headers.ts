import { z } from 'zod';
import type { QuotaProvider } from '../../shared/contracts.ts';
import type { QuotaBucket, QuotaSnapshot } from '../../shared/index.ts';

/**
 * Cupo a partir de las cabeceras de límite que envían algunos proveedores en cada respuesta:
 * - Anthropic: `anthropic-ratelimit-{requests|tokens|input-tokens|output-tokens}-{limit|remaining|reset}`
 *   (reset en RFC 3339), además de `anthropic-priority-*` y `anthropic-fast-*`.
 * - OpenAI y compatibles: `x-ratelimit-{limit|remaining|reset}-{requests|tokens|project-tokens}`
 *   (reset como duración: `1s`, `6m0s`).
 * - OpenRouter y otros: `x-ratelimit-{limit|remaining|reset}` sin sufijo (reset como época en ms).
 * Los límites de estas cabeceras son por minuto (o por día en algunos niveles de OpenAI), así que la ventana es `custom`.
 */

export type HeadersLike = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

type Field = 'limit' | 'remaining' | 'reset';

interface RawLimit {
  limit?: number;
  remaining?: number;
  reset?: string;
}

const numberHeader = z.string().trim().regex(/^\d+(?:\.\d+)?$/).transform(Number);

function toMap(headers: HeadersLike): Map<string, string> {
  const map = new Map<string, string>();
  if (headers instanceof Headers) {
    headers.forEach((value, key) => map.set(key.toLowerCase(), value));
    return map;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    map.set(key.toLowerCase(), typeof value === 'string' ? value : value.join(', '));
  }
  return map;
}

/** Devuelve [grupo, campo] si la cabecera es de límite; si no, undefined. */
function classify(name: string): [string, Field] | undefined {
  let m = /^anthropic-(ratelimit|priority|fast)-(.+)-(limit|remaining|reset)$/.exec(name);
  if (m) {
    const [, family, resource, field] = m as unknown as [string, string, string, Field];
    return [family === 'ratelimit' ? resource : `${family}-${resource}`, field];
  }
  m = /^x-ratelimit-(limit|remaining|reset)-(.+)$/.exec(name);
  if (m) return [m[2] as string, m[1] as Field];
  m = /^(?:x-)?ratelimit-(limit|remaining|reset)$/.exec(name);
  if (m) return ['requests', m[1] as Field];
  return undefined;
}

/** True si hay al menos una cabecera de límite reconocible. */
export function hasRateLimitHeaders(headers: HeadersLike): boolean {
  for (const key of toMap(headers).keys()) if (classify(key)) return true;
  return false;
}

/** Duración al estilo Go (`1h2m3.5s`, `6m0s`, `250ms`) a milisegundos. */
export function parseDurationMs(text: string): number | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const m of value.matchAll(re)) {
    if (m.index !== consumed) return undefined;
    const amount = Number(m[1]);
    const unit = m[2];
    total += unit === 'h' ? amount * 3_600_000 : unit === 'm' ? amount * 60_000 : unit === 's' ? amount * 1000 : amount;
    consumed += m[0].length;
  }
  return consumed === value.length && consumed > 0 ? total : undefined;
}

/** Hora de reinicio en ISO: acepta RFC 3339, duración relativa o número (época en ms/s, o segundos relativos). */
export function parseResetAt(text: string, now: Date): string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const numeric = numberHeader.safeParse(value);
  if (numeric.success) {
    const n = numeric.data;
    const ms = n >= 1e12 ? n : n >= 1e9 ? n * 1000 : now.getTime() + n * 1000;
    return new Date(ms).toISOString();
  }
  const duration = parseDurationMs(value);
  if (duration !== undefined) return new Date(now.getTime() + duration).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

const GROUP_NAMES: Readonly<Record<string, string>> = {
  requests: 'Solicitudes',
  tokens: 'Tokens',
  'input-tokens': 'Tokens de entrada',
  'output-tokens': 'Tokens de salida',
  'project-tokens': 'Tokens del proyecto',
  'project-requests': 'Solicitudes del proyecto',
};

function groupName(groupId: string): string {
  const qualifier = groupId.startsWith('priority-') ? ' (prioridad)' : groupId.startsWith('fast-') ? ' (modo rápido)' : '';
  const base = groupId.replace(/^(priority|fast)-/, '');
  return `${GROUP_NAMES[base] ?? base}${qualifier}`;
}

/**
 * Convierte las cabeceras en buckets (uno por recurso). Las duraciones relativas se resuelven contra
 * `receivedAt` (cuando llegó la respuesta); un bucket cuyo reinicio ya pasó en `now` se considera
 * repuesto por completo (los proveedores usan cubeta de tokens).
 */
export function parseRateLimitHeaders(headers: HeadersLike, receivedAt: Date = new Date(), now: Date = receivedAt): QuotaBucket[] {
  const groups = new Map<string, RawLimit>();
  for (const [key, raw] of toMap(headers)) {
    const hit = classify(key);
    if (!hit) continue;
    const [groupId, field] = hit;
    const entry = groups.get(groupId) ?? {};
    if (field === 'reset') entry.reset = raw;
    else {
      const parsed = numberHeader.safeParse(raw);
      if (parsed.success) entry[field] = parsed.data;
    }
    groups.set(groupId, entry);
  }

  const buckets: QuotaBucket[] = [];
  for (const [groupId, entry] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.limit === undefined && entry.remaining === undefined) continue;
    const unit = groupId.includes('token') ? 'tokens' : 'requests';
    const resetAt = entry.reset !== undefined ? parseResetAt(entry.reset, receivedAt) : undefined;
    const replenished = resetAt !== undefined && Date.parse(resetAt) <= now.getTime() && entry.limit !== undefined;
    const remaining = replenished ? entry.limit : entry.remaining;
    let fraction: number | null = null;
    if (remaining !== undefined && entry.limit !== undefined && entry.limit > 0) {
      fraction = Math.min(1, Math.max(0, remaining / entry.limit));
    }
    const bucket: QuotaBucket = {
      groupId,
      groupName: groupName(groupId),
      window: 'custom',
      remainingFraction: fraction,
    };
    if (remaining !== undefined) bucket.remainingUnits = { amount: remaining, unit };
    if (resetAt !== undefined && !replenished) bucket.resetAt = resetAt;
    buckets.push(bucket);
  }
  return buckets;
}

export interface ResponseHeadersQuotaOptions {
  agentId: string;
  now?: () => Date;
  /** Antigüedad a partir de la cual la última lectura se marca `stale` (por defecto 10 min). */
  staleAfterMs?: number;
}

/**
 * QuotaProvider alimentado por el adaptador: cada respuesta del proveedor llama a `update(headers)`
 * (no hace llamadas propias, así que leerlo no gasta cupo).
 */
export class ResponseHeadersQuota implements QuotaProvider {
  readonly agentId: string;
  readonly #now: () => Date;
  readonly #staleAfterMs: number;
  #last: { headers: Map<string, string>; at: Date } | undefined;

  constructor(opts: ResponseHeadersQuotaOptions) {
    this.agentId = opts.agentId;
    this.#now = opts.now ?? (() => new Date());
    this.#staleAfterMs = opts.staleAfterMs ?? 10 * 60_000;
  }

  /** Guarda las cabeceras si traen límites. Devuelve true si las usó. */
  update(headers: HeadersLike, at: Date = this.#now()): boolean {
    if (!hasRateLimitHeaders(headers)) return false;
    this.#last = { headers: toMap(headers), at };
    return true;
  }

  async read(): Promise<QuotaSnapshot> {
    const now = this.#now();
    if (!this.#last) {
      return {
        agentId: this.agentId,
        method: 'response-headers',
        takenAt: now.toISOString(),
        buckets: [],
        stale: true,
        error: 'Aún no hay respuestas con cabeceras de límite.',
      };
    }
    const headers = Object.fromEntries(this.#last.headers);
    return {
      agentId: this.agentId,
      method: 'response-headers',
      takenAt: this.#last.at.toISOString(),
      buckets: parseRateLimitHeaders(headers, this.#last.at, now),
      stale: now.getTime() - this.#last.at.getTime() > this.#staleAfterMs,
    };
  }
}
