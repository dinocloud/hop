import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from '../../lib/logger.js';

/**
 * Hook de estado del paquete. Placeholder: la lógica real llega en el PR
 * "feat/package-status-hook" (ticket 86e3pnvz8).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  logger.info('package-status-hook placeholder', {
    trackingId: event.pathParameters?.trackingId,
  });
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, placeholder: true }),
  };
}
