import { Logger } from '@aws-lambda-powertools/logger';

/**
 * Logger JSON estructurado (Powertools). El `serviceName` lo fija la variable
 * `POWERTOOLS_SERVICE_NAME` que define el stack por Lambda.
 *
 * Nunca loguear el teléfono completo: usar `maskPhone`.
 */
export const logger = new Logger();

/** Deja visibles solo los últimos 4 dígitos: `+5491112345678` → `***5678`. */
export function maskPhone(phone: string | undefined): string {
  if (!phone) return 'unknown';
  if (phone.length < 8) return '***';
  return `***${phone.slice(-4)}`;
}
