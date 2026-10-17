/**
 * Clasificación de errores de AWS para decidir si vale la pena reintentar.
 * Transitorio: throttling, 5xx, timeouts y cortes de red. Permanente: validación,
 * permisos, recursos inexistentes.
 */

/** Timeouts por request para los clientes del SDK: la Lambda tiene que responder antes que API Gateway (29 s). */
export const SDK_TIMEOUTS = { requestTimeout: 5_000, connectionTimeout: 1_000 } as const;

const TRANSIENT_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'InternalServerException',
  'InternalFailure',
  'InternalServerError',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'NetworkingError',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

interface AwsLikeError {
  name?: string;
  code?: string;
  $retryable?: { throttling?: boolean };
  $metadata?: { httpStatusCode?: number };
}

export function isTransientAwsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as AwsLikeError;
  if (e.$retryable?.throttling) return true;
  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined && status >= 500) return true;
  return TRANSIENT_NAMES.has(e.name ?? '') || TRANSIENT_NAMES.has(e.code ?? '');
}

export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  if (typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return 'UnknownError';
}

export function errorInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'UnknownError', message: String(err) };
}
