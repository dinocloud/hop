import { describe, expect, it } from 'vitest';
import { SDK_TIMEOUTS, errorName, isAmbiguousSendError, isTransientAwsError } from '../../src/lib/aws-errors.js';

function named(name: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(name);
  err.name = name;
  return Object.assign(err, extra);
}

describe('isTransientAwsError', () => {
  it('reconoce throttling, 5xx y timeouts como transitorios', () => {
    expect(isTransientAwsError(named('ThrottlingException'))).toBe(true);
    expect(isTransientAwsError(named('Whatever', { $retryable: { throttling: true } }))).toBe(true);
    expect(isTransientAwsError(named('InternalServerException', { $metadata: { httpStatusCode: 500 } }))).toBe(true);
    expect(isTransientAwsError(named('TimeoutError'))).toBe(true);
    expect(isTransientAwsError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('trata el throttling de End User Messaging Social (ThrottledRequestException, 429) como transitorio', () => {
    expect(isTransientAwsError(named('ThrottledRequestException', { $metadata: { httpStatusCode: 429 }, $retryable: {} }))).toBe(true);
    expect(isTransientAwsError(named('Whatever', { $metadata: { httpStatusCode: 429 } }))).toBe(true);
  });

  it('trata validación, permisos y recursos inexistentes como permanentes', () => {
    expect(isTransientAwsError(named('ValidationException', { $metadata: { httpStatusCode: 400 } }))).toBe(false);
    expect(isTransientAwsError(named('AccessDeniedException', { $metadata: { httpStatusCode: 403 } }))).toBe(false);
    expect(isTransientAwsError(named('ResourceNotFoundException'))).toBe(false);
    expect(isTransientAwsError(new Error('Template name does not exist'))).toBe(false);
    expect(isTransientAwsError(null)).toBe(false);
  });

  it('errorName devuelve algo útil siempre', () => {
    expect(errorName(named('AccessDeniedException'))).toBe('AccessDeniedException');
    expect(errorName('x')).toBe('UnknownError');
  });
});

describe('isAmbiguousSendError', () => {
  it('reconoce timeouts y cortes de conexión, en los que el mensaje pudo haber salido', () => {
    expect(isAmbiguousSendError(named('TimeoutError'))).toBe(true);
    expect(isAmbiguousSendError(named('AbortError'))).toBe(true);
    expect(isAmbiguousSendError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('no confunde throttling ni errores del servidor con un resultado desconocido', () => {
    expect(isAmbiguousSendError(named('ThrottledRequestException', { $metadata: { httpStatusCode: 429 } }))).toBe(false);
    expect(isAmbiguousSendError(named('InternalServerException', { $metadata: { httpStatusCode: 500 } }))).toBe(false);
    expect(isAmbiguousSendError(null)).toBe(false);
  });
});

describe('SDK_TIMEOUTS', () => {
  it('corta de verdad los requests colgados: sin throwOnRequestTimeout, smithy solo loguea un warning', () => {
    expect(SDK_TIMEOUTS).toEqual({ requestTimeout: 5_000, connectionTimeout: 1_000, throwOnRequestTimeout: true });
  });
});
