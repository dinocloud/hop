import { Logger } from '@aws-lambda-powertools/logger';

/**
 * Logger JSON estructurado (Powertools). El `serviceName` lo fija la variable
 * `POWERTOOLS_SERVICE_NAME` que define el stack por Lambda.
 *
 * Nunca loguear el teléfono completo: usar `maskPhone`.
 */
export const logger = new Logger();

/** `+5491112345678` → `+54******5678`. */
export function maskPhone(phone: string | undefined): string {
  if (!phone) return 'unknown';
  if (phone.length <= 6) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}
