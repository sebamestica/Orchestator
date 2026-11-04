import type { ErrorCode } from '../../../shared/index.ts';

/**
 * Clasificación de errores del SDK de Claude en los códigos del contrato.
 * - `auth`: clave inválida, rechazada o ausente (401/403, `authentication_failed`…).
 * - `quota_exhausted`: saldo o crédito insuficiente (402, `billing_error`, «credit balance is too low»),
 *   tope de presupuesto (`error_max_budget_usd`) o 429 que persiste tras los reintentos del SDK.
 */

const AUTH_PATTERNS: readonly RegExp[] = [
  /invalid[\s_-]*(?:x-)?api[\s_-]*key/i,
  /authentication[\s_-]*(?:error|failed)/i,
  /\bunauthori[sz]ed\b/i,
  /\bnot logged in\b/i,
  /please run \/login/i,
  /oauth token (?:has )?expired/i,
  /permission[\s_-]*denied/i,
  /\b40[13]\b.*(?:key|auth|forbidden)/i,
];

const QUOTA_PATTERNS: readonly RegExp[] = [
  /credit balance (?:is )?too low/i,
  /insufficient[\s_-]*(?:credit|credits|balance|funds|quota)/i,
  /out of credits/i,
  /billing[\s_-]*error/i,
  /payment required/i,
  /\bsaldo insuficiente\b/i,
  /max(?:imum)?[\s_-]*budget/i,
  /rate[\s_-]*limit/i,
  /too many requests/i,
  /\b(?:402|429)\b/,
];

/** Errores de `SDKAssistantMessage.error`. */
const ASSISTANT_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'quota_exhausted',
  rate_limit: 'quota_exhausted',
};

export function codeFromAssistantError(error: string | undefined): ErrorCode | undefined {
  return error ? ASSISTANT_ERROR_CODES[error] : undefined;
}

export function codeFromHttpStatus(status: number | null | undefined): ErrorCode | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'quota_exhausted';
  return undefined;
}

/** Código a partir del texto de un error (mensaje de excepción, `result`, `errors[]`, stderr). */
export function codeFromText(text: string): ErrorCode | undefined {
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth';
  if (QUOTA_PATTERNS.some((p) => p.test(text))) return 'quota_exhausted';
  return undefined;
}

export interface ErrorEvidence {
  subtype?: string;
  httpStatus?: number | null;
  assistantError?: string;
  texts?: readonly string[];
}

/** Elige el código más específico con todas las pistas disponibles. */
export function classifyClaudeError(evidence: ErrorEvidence, fallback: ErrorCode = 'unknown'): ErrorCode {
  if (evidence.subtype === 'error_max_budget_usd') return 'quota_exhausted';
  return (
    codeFromHttpStatus(evidence.httpStatus) ??
    codeFromAssistantError(evidence.assistantError) ??
    codeFromText((evidence.texts ?? []).join('\n')) ??
    fallback
  );
}
