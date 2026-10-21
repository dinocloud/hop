import type { SNSEvent } from 'aws-lambda';
import { logger } from '../../lib/logger.js';

/**
 * Router de mensajes entrantes de WhatsApp (SNS). Placeholder: la lógica real
 * llega en el PR "feat/inbound-router" (ticket 86e3pnvzj).
 */
export async function handler(event: SNSEvent): Promise<void> {
  logger.info('inbound-router placeholder', { records: event.Records.length });
}
