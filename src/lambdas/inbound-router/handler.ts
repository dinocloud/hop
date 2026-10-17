import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { Context, SNSEvent } from 'aws-lambda';
import { FALLBACK_REPLY, type AgentReply } from '../../lib/agent-contract.js';
import { createAgentClient, type AgentClient } from '../../lib/agentcore.js';
import { errorInfo, isTransientAwsError } from '../../lib/aws-errors.js';
import { createRepos, type Repos } from '../../lib/dynamo.js';
import { InboundEventError, parseInboundEvent, type InboundTextMessage } from '../../lib/inbound-event.js';
import { logger, maskPhone } from '../../lib/logger.js';
import { createWhatsAppSender, OutsideWindowError, type WhatsAppSender } from '../../lib/whatsapp.js';

/**
 * Router de mensajes entrantes de WhatsApp.
 *
 * SNS (End User Messaging Social) → esta Lambda → AgentCore Runtime → respuesta por WhatsApp
 * (texto y, si el agente devuelve `location`, el pin del Punto HOP).
 *
 * Garantías:
 * - Cada mensaje se procesa exactamente una vez aunque SNS/Lambda reintenten
 *   (`claimMessage` con lease; `completeMessage` al terminar; `releaseMessage` si falla).
 * - Nunca se deja una conversación sin respuesta por un error del agente: se manda un texto de
 *   disculpa. Si ni eso se puede enviar por una causa transitoria, se lanza para que Lambda
 *   reintente; si es permanente, queda en el log y la métrica.
 * - La ventana de 24 h se abre con la fecha del mensaje del cliente (`touchInbound`).
 */

export interface RouterMetrics {
  addMetric(name: string, unit: (typeof MetricUnit)[keyof typeof MetricUnit], value: number): void;
  publishStoredMetrics(): void;
}

export interface RouterDeps {
  repos: Pick<Repos, 'claimMessage' | 'completeMessage' | 'releaseMessage' | 'touchInbound'>;
  agent: Pick<AgentClient, 'invoke'>;
  sender: Pick<WhatsAppSender, 'sendText' | 'sendLocation'>;
  metrics?: RouterMetrics;
  now?: () => Date;
}

export const METRICS = {
  processed: 'InboundProcessed',
  duplicate: 'InboundDuplicate',
  ignored: 'InboundIgnored',
  agentFailed: 'AgentFailed',
  replyFailed: 'ReplyFailed',
} as const;

export function createHandler(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date());
  const metrics = deps.metrics ?? noopMetrics;

  return async function handler(event: SNSEvent, context?: Context): Promise<void> {
    if (context) logger.addContext(context);
    try {
      for (const record of event.Records) {
        await handleRecord(record.Sns.Message, record.Sns.MessageId);
      }
    } finally {
      metrics.publishStoredMetrics();
    }
  };

  async function handleRecord(snsMessage: string, snsMessageId: string): Promise<void> {
    let parsed;
    try {
      parsed = parseInboundEvent(snsMessage);
    } catch (err) {
      if (err instanceof InboundEventError) {
        // Formato desconocido: no tiene sentido reintentar. Queda en el log y en la métrica.
        logger.error('Evento de SNS con formato inesperado', { snsMessageId, error: errorInfo(err) });
        metrics.addMetric(METRICS.ignored, MetricUnit.Count, 1);
        return;
      }
      throw err;
    }
    if (parsed.otherMessages > 0) {
      logger.info('Mensajes no soportados (solo texto)', { snsMessageId, count: parsed.otherMessages });
      metrics.addMetric(METRICS.ignored, MetricUnit.Count, parsed.otherMessages);
    }
    for (const message of parsed.textMessages) {
      await handleMessage(message);
    }
  }

  async function handleMessage(message: InboundTextMessage): Promise<void> {
    logger.appendKeys({ messageId: message.messageId, phone: maskPhone(message.from) });

    if (!(await deps.repos.claimMessage(message.messageId, now()))) {
      logger.info('Mensaje ya procesado o en proceso, se descarta');
      metrics.addMetric(METRICS.duplicate, MetricUnit.Count, 1);
      return;
    }

    try {
      const conversation = await deps.repos.touchInbound(message.from, message.sentAt);
      const reply = await askAgent(message, conversation.sessionId);
      await sendReply(message.from, reply);
      await deps.repos.completeMessage(message.messageId, now());
      metrics.addMetric(METRICS.processed, MetricUnit.Count, 1);
    } catch (err) {
      // Liberar el lease para que el reintento de Lambda lo retome enseguida.
      await deps.repos.releaseMessage(message.messageId).catch((e: unknown) => {
        logger.error('No se pudo liberar el lease del mensaje', { error: errorInfo(e) });
      });
      throw err;
    } finally {
      logger.removeKeys(['messageId', 'phone']);
    }
  }

  async function askAgent(message: InboundTextMessage, sessionId: string | undefined): Promise<AgentReply> {
    if (!sessionId) {
      logger.error('La conversación no tiene sessionId');
      metrics.addMetric(METRICS.agentFailed, MetricUnit.Count, 1);
      return FALLBACK_REPLY;
    }
    try {
      return await deps.agent.invoke({ phone: message.from, text: message.text }, sessionId);
    } catch (err) {
      logger.error('El agente falló; se responde con el texto de disculpa', { error: errorInfo(err) });
      metrics.addMetric(METRICS.agentFailed, MetricUnit.Count, 1);
      return FALLBACK_REPLY;
    }
  }

  async function sendReply(phone: string, reply: AgentReply): Promise<void> {
    try {
      await deps.sender.sendText(phone, reply.text);
      if (reply.location) await deps.sender.sendLocation(phone, reply.location);
    } catch (err) {
      metrics.addMetric(METRICS.replyFailed, MetricUnit.Count, 1);
      if (err instanceof OutsideWindowError) {
        // El cliente acaba de escribir: no debería pasar. Si pasa, no hay nada que reintentar.
        logger.error('Ventana de 24 h cerrada al responder', { error: errorInfo(err) });
        return;
      }
      if (isTransientAwsError(err)) {
        logger.warn('Envío de la respuesta falló por causa transitoria; Lambda reintenta', { error: errorInfo(err) });
        throw err;
      }
      logger.error('No se pudo enviar la respuesta', { error: errorInfo(err) });
    }
  }
}

// Instancia perezosa para la Lambda real (los tests usan createHandler con mocks).
let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: SNSEvent, context: Context): Promise<void> => {
  if (!cached) {
    const repos = createRepos();
    cached = createHandler({
      repos,
      agent: createAgentClient(),
      sender: createWhatsAppSender({ getConversation: repos.getConversation }),
      metrics: new Metrics({ namespace: 'HopHackathon', serviceName: 'inbound-router' }),
    });
  }
  return cached(event, context);
};

const noopMetrics: RouterMetrics = { addMetric: () => undefined, publishStoredMetrics: () => undefined };
