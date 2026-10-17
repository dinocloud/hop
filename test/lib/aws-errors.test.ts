import { describe, expect, it } from 'vitest';
import { errorName, isTransientAwsError } from '../../src/lib/aws-errors.js';

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
