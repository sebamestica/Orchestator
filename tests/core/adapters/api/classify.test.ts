import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk';
import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { classifyApiError, HttpError, InvalidOutputError } from '../../../../src/core/adapters/api/index.ts';
import { RedactingTextBuffer } from '../../../../src/core/adapters/api/events.ts';
import { REDACTED } from '../../../../src/shared/index.ts';
import { KEY, PLAIN_KEY } from './helpers.ts';

function apiCallError(statusCode: number, responseBody: string, message = ''): APICallError {
  return new APICallError({ message, url: 'https://api.ejemplo.cl/v1/chat/completions', requestBodyValues: {}, statusCode, responseBody });
}

describe('classifyApiError', () => {
  it('distingue abortos y plazos de los SDK', () => {
    expect(classifyApiError(new APIUserAbortError()).code).toBe('cancelled');
    expect(classifyApiError(new APIConnectionTimeoutError()).code).toBe('timeout');
    expect(classifyApiError(new DOMException('x', 'TimeoutError')).code).toBe('timeout');
    expect(classifyApiError(new DOMException('x', 'AbortError')).code).toBe('cancelled');
    expect(classifyApiError(new APIConnectionError({ message: 'ECONNREFUSED' }))).toMatchObject({ code: 'unknown' });
  });

  it('usa el último error de RetryError y cuenta los intentos', () => {
    const last = apiCallError(429, '{"error":{"message":"slow"}}', 'slow');
    const err = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [last, last, last] });
    expect(classifyApiError(err)).toEqual({ code: 'quota_exhausted', message: 'HTTP 429: slow (tras 3 intentos)', status: 429 });
  });

  it('reconoce cupo y clave por el cuerpo aunque el estado no lo diga', () => {
    expect(classifyApiError(apiCallError(400, '{"error":{"message":"Your credit balance is too low"}}')).code).toBe('quota_exhausted');
    expect(classifyApiError(apiCallError(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}')).code).toBe('auth');
    expect(classifyApiError(apiCallError(500, 'Internal error')).code).toBe('unknown');
    expect(classifyApiError(apiCallError(500, 'Internal error')).message).toBe('HTTP 500: Internal error');
  });

  it('acepta errores sueltos de la transmisión y los propios del adaptador', () => {
    expect(classifyApiError({ error: { code: 402, message: 'Insufficient credits' } }).code).toBe('quota_exhausted');
    expect(classifyApiError({ type: 'error', code: 'insufficient_quota', message: 'quota' }).code).toBe('quota_exhausted');
    expect(classifyApiError(new HttpError(403, 'forbidden', new Headers(), 'https://x.cl/models?key=abc'))).toMatchObject({ code: 'auth', status: 403 });
    expect(classifyApiError(new HttpError(403, '', new Headers(), 'https://x.cl/models?key=abc')).message).not.toContain('key=abc');
    expect(classifyApiError(new InvalidOutputError('raro')).code).toBe('invalid_output');
    expect(classifyApiError(new Error('algo pasó'))).toEqual({ code: 'unknown', message: 'algo pasó' });
  });
});

describe('RedactingTextBuffer', () => {
  it('deja pasar el texto sin demora cuando la cola no puede ser el comienzo de una clave', () => {
    const buffer = new RedactingTextBuffer([KEY]);
    expect(buffer.push('Hola ')).toBe('Hola ');
    expect(buffer.push('mundo.')).toBe('mundo.');
    expect(buffer.flush()).toBe('');
  });

  it('retiene solo el posible comienzo de una clave y lo suelta si no se completa', () => {
    const buffer = new RedactingTextBuffer([PLAIN_KEY]);
    expect(buffer.push('ver clave-pro')).toBe('ver ');
    expect(buffer.push('xy y listo')).toBe('clave-proxy y listo');
    expect(buffer.push(`fin ${PLAIN_KEY.slice(0, 5)}`)).toBe('fin ');
    expect(buffer.push(`${PLAIN_KEY.slice(5)}!`)).toBe(`${REDACTED}!`);
    expect(buffer.push('cla')).toBe('');
    expect(buffer.flush()).toBe('cla');
  });

  it('ignora secretos cortos, como redactSecrets', () => {
    const buffer = new RedactingTextBuffer(['1', 'corto']);
    expect(buffer.push('cor')).toBe('cor');
  });
});
