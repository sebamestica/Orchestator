import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  NoContentGeneratedError,
  RetryError,
  TypeValidationError,
} from 'ai';
import type { ErrorCode } from '../../../shared/index.ts';
import { HttpError } from './http.ts';

/**
 * Clasificación de errores de los SDK (Anthropic y AI SDK) y de las llamadas propias en los códigos del contrato:
 * - `auth`: 401/403, clave inválida (Google responde 400 `API_KEY_INVALID`), `authentication_error`, `permission_error`.
 * - `quota_exhausted`: 429 que persiste tras los reintentos del SDK, 402 (OpenRouter sin saldo),
 *   `insufficient_quota` (OpenAI), `billing_error` o «credit balance is too low» (Anthropic), `RESOURCE_EXHAUSTED` (Google).
 * - `cancelled` / `timeout`: abortos; el adaptador decide con sus propias banderas cuál fue (señal del contexto o plazo).
 * - `invalid_output`: respuesta que no cumple el formato esperado.
 */

/** Respuesta del proveedor que no pasa la validación Zod del adaptador. */
export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

export interface ClassifiedError {
  code: ErrorCode;
  /** Mensaje para el evento `error` (aún sin tachar: lo tacha la fábrica de eventos). */
  message: string;
  status?: number;
}

const AUTH_PATTERNS: readonly RegExp[] = [
  /invalid[\s_-]*(?:x-)?api[\s_-]*key/i,
  /api[\s_-]*key not valid/i,
  /API_KEY_INVALID/,
  /authentication[\s_-]*(?:error|failed)/i,
  /permission[\s_-]*(?:error|denied)/i,
  /\bUNAUTHENTICATED\b/,
  /\bunauthori[sz]ed\b/i,
];

const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient[\s_-]*quota/i,
  /insufficient[\s_-]*(?:credits?|balance|funds)/i,
  /credit balance (?:is )?too low/i,
  /out of credits/i,
  /billing[\s_-]*error/i,
  /payment required/i,
  /exceeded your current quota/i,
  /quota[\s_-]*exceeded/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /rate[\s_-]*limit[\s_-]*(?:error|exceeded)/i,
];

/** Tipos de `error.type` de Anthropic (también llegan como evento `error` a mitad de la transmisión). */
const ANTHROPIC_TYPES: Readonly<Record<string, ErrorCode>> = {
  authentication_error: 'auth',
  permission_error: 'auth',
  rate_limit_error: 'quota_exhausted',
  billing_error: 'quota_exhausted',
};

export function codeFromStatus(status: number | undefined): ErrorCode | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'quota_exhausted';
  return undefined;
}

export function codeFromText(text: string): ErrorCode | undefined {
  if (QUOTA_PATTERNS.some((p) => p.test(text))) return 'quota_exhausted';
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth';
  return undefined;
}

function errorName(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string') return err.name;
  return undefined;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return true;
  if (RetryError.isInstance(err) && err.reason === 'abort') return true;
  return errorName(err) === 'AbortError';
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof APIConnectionTimeoutError || errorName(err) === 'TimeoutError';
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    if ('message' in err && typeof err.message === 'string') return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Estado HTTP en objetos de error sueltos (p. ej. `{ error: { code: 402 } }` de OpenRouter a mitad de la transmisión). */
function statusFromObject(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = 'code' in err ? err.code : undefined;
  if (typeof code === 'number' && code >= 400 && code < 600) return code;
  const inner = 'error' in err ? err.error : undefined;
  return inner !== err ? statusFromObject(inner) : undefined;
}

export function classifyApiError(err: unknown): ClassifiedError {
  let attempts: number | undefined;
  let cause = err;
  if (RetryError.isInstance(err) && err.reason !== 'abort') {
    attempts = err.errors.length;
    cause = err.lastError ?? err;
  }
  const suffix = attempts && attempts > 1 ? ` (tras ${attempts} intentos)` : '';

  if (isAbortError(cause)) return { code: 'cancelled', message: 'Solicitud cancelada.' };
  if (isTimeoutError(cause)) return { code: 'timeout', message: `Se agotó el tiempo de espera: ${truncate(messageOf(cause))}` };

  if (cause instanceof APIError && !(cause instanceof APIConnectionError)) {
    const status = typeof cause.status === 'number' ? cause.status : undefined;
    const text = `${cause.message} ${cause.type ?? ''}`;
    const code = codeFromStatus(status) ?? (cause.type ? ANTHROPIC_TYPES[cause.type] : undefined) ?? codeFromText(text) ?? 'unknown';
    const prefix = status ? `HTTP ${status}` : `Error de Anthropic${cause.type ? ` (${cause.type})` : ''}`;
    return withStatus({ code, message: `${prefix}: ${truncate(cause.message)}${suffix}` }, status);
  }
  if (cause instanceof APIConnectionError) {
    return { code: 'unknown', message: `No se pudo conectar con el proveedor: ${truncate(cause.message)}${suffix}` };
  }

  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    const text = `${cause.message} ${cause.responseBody ?? ''}`;
    const code = codeFromStatus(status) ?? codeFromText(text) ?? 'unknown';
    const prefix = status ? `HTTP ${status}` : 'Error de la API';
    // Si el cuerpo no sigue el formato del proveedor (p. ej. un proxy), el SDK deja el mensaje vacío: se usa el cuerpo.
    const detail = cause.message.trim() || cause.responseBody?.trim() || 'sin detalle';
    return withStatus({ code, message: `${prefix}: ${truncate(detail)}${suffix}` }, status);
  }

  if (cause instanceof HttpError) {
    const code = codeFromStatus(cause.status) ?? codeFromText(cause.body) ?? 'unknown';
    return withStatus({ code, message: truncate(cause.message) }, cause.status);
  }

  if (
    cause instanceof InvalidOutputError ||
    TypeValidationError.isInstance(cause) ||
    JSONParseError.isInstance(cause) ||
    InvalidResponseDataError.isInstance(cause) ||
    EmptyResponseBodyError.isInstance(cause) ||
    NoContentGeneratedError.isInstance(cause)
  ) {
    return { code: 'invalid_output', message: `Respuesta con formato inesperado: ${truncate(messageOf(cause))}` };
  }

  const text = messageOf(cause);
  const status = statusFromObject(cause);
  // En objetos sueltos (p. ej. el evento `error` de OpenAI con `code: "insufficient_quota"`) se busca también en sus campos.
  const searchable = typeof cause === 'object' && cause !== null && !(cause instanceof Error) ? `${text} ${safeJson(cause)}` : text;
  const code = codeFromStatus(status) ?? codeFromText(searchable) ?? 'unknown';
  return withStatus({ code, message: `${truncate(text)}${suffix}` }, status);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function withStatus(result: ClassifiedError, status: number | undefined): ClassifiedError {
  return status === undefined ? result : { ...result, status };
}
