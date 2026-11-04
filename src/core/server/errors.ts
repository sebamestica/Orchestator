import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { redactSecrets } from '../../shared/index.ts';
import { RegistryError } from '../registry/index.ts';
import { StoreError } from '../store/index.ts';
import { VaultError } from '../vault/index.ts';

export const API_ERROR_CODES = [
  'unauthorized',
  'forbidden_host',
  'forbidden_origin',
  'invalid_request',
  'invalid_json',
  'unsupported_media_type',
  'payload_too_large',
  'not_found',
  'conflict',
  'probe_failed',
  'plan_invalid',
  'not_configured',
  'upgrade_required',
  'vault_error',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorDetails {
  warnings?: string[];
  issues?: { code: string; message: string; taskIds?: string[] }[];
}

/** Error que el servidor convierte en `{error:{code,message}}`. El mensaje nunca lleva datos de entrada. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly details?: ApiErrorDetails;
  constructor(status: ContentfulStatusCode, code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export interface ErrorBody {
  error: { code: ApiErrorCode; message: string } & ApiErrorDetails;
}

const STORE_STATUS = { invalid: [400, 'invalid_request'], not_found: [404, 'not_found'], conflict: [409, 'conflict'] } as const;
const REGISTRY_STATUS = {
  invalid: [400, 'invalid_request'],
  not_found: [404, 'not_found'],
  conflict: [409, 'conflict'],
  probe_failed: [422, 'probe_failed'],
  not_configured: [501, 'not_configured'],
} as const;

/** Traduce cualquier error a `ApiError`. Los desconocidos pierden su mensaje (puede contener datos). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof StoreError) {
    const [status, code] = STORE_STATUS[err.code];
    return new ApiError(status, code, err.message);
  }
  if (err instanceof RegistryError) {
    const [status, code] = REGISTRY_STATUS[err.code];
    return new ApiError(status, code, err.message, err.details);
  }
  // Los mensajes de la bóveda están construidos para no incluir valores.
  if (err instanceof VaultError) return new ApiError(500, 'vault_error', err.message);
  if (err instanceof HTTPException) {
    if (err.status === 413) return new ApiError(413, 'payload_too_large', 'El cuerpo supera el tamaño máximo');
    return new ApiError(err.status, err.status === 401 ? 'unauthorized' : 'invalid_request', 'Solicitud rechazada');
  }
  return new ApiError(500, 'internal', 'Error interno');
}

export function errorBody(err: ApiError): ErrorBody {
  return {
    error: {
      code: err.code,
      message: redactSecrets(err.message).slice(0, 1000),
      ...(err.details?.warnings ? { warnings: err.details.warnings.map((w) => redactSecrets(w)) } : {}),
      ...(err.details?.issues
        ? { issues: err.details.issues.map((i) => ({ ...i, message: redactSecrets(i.message) })) }
        : {}),
    },
  };
}
