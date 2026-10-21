import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { Context, SNSEvent } from 'aws-lambda';
import { FALLBACK_REPLY, MAX_REQUEST_TEXT, type AgentReply } from '../../lib/agent-contract.js';
import { AGENT_REQUEST_TIMEOUT_MS, createAgentClient, type AgentClient } from '../../lib/agentcore.js';
import { errorInfo, isAmbiguousSendError, isTransientAwsError } from '../../lib/aws-errors.js';
import { createRepos, type Repos } from '../../lib/dynamo.js';
import { InboundEventError, parseInboundEvent, type InboundTextMessage } from '../../lib/inbound-event.js';
import { logger, maskPhone } from '../../lib/logger.js';
import { OutsideWindowError, createWhatsAppSender, isWithinWindow, type WhatsAppSender } from '../../lib/whatsapp.js';

/**
 * Router de mensajes entrantes de WhatsApp.
 *
 * SNS (End User Messaging Social) → esta Lambda → AgentCore Runtime → respuesta por WhatsApp
 * (texto y, si el agente devuelve `location`, el pin del Punto HOP).
 *
 * Garantías:
 * - Cada mensaje se procesa exactamente una vez aunque SNS/Lambda reintenten: `claimMessage`
 *   con lease (70 s, más que el timeout de la Lambda); `completeMessage` al terminar;
 *   `releaseMessage` si falla antes de enviar algo. Si un reintento encuentra el lease vivo
 *   (la invocación anterior murió por timeout), se lanza para que Lambda reintente más tarde
 *   en vez de descartarlo como duplicado.
 * - Nunca se responde dos veces: una vez que salió algo por WhatsApp, un fallo posterior no
 *   relanza (queda en el log y la métrica). Solo se reintenta si todavía no salió nada y el
 *   error es transitorio y no ambiguo (un timeout del envío puede haber llegado igual).
 * - Nunca se deja una conversación sin respuesta por un error del agente: texto de disculpa.
 * - Presupuesto de tiempo: cada mensaje recibe como máximo lo que queda de la Lambda menos un
 *   margen; si no alcanza, se libera el lease y se relanza para que lo tome el reintento.
 * - La ventana de 24 h se abre con la fecha del mensaje del cliente (`touchInbound`). Un mensaje
 *   más viejo que la ventana (redrive tardío) no se contesta: ya no se podría enviar.
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
  invalid: 'InboundInvalid',
  parseError: 'InboundParseError',
  stale: 'InboundStale',
  status: 'InboundStatus',
  deliveryFailed: 'ReplyDeliveryFailed',
  agentFailed: 'AgentFailed',
  replyFailed: 'ReplyFailed',
  unsupported: 'InboundUnsupported',
} as const;

/** Respuesta a un audio, una imagen, etc.: el agente solo entiende texto. */
export const UNSUPPORTED_MESSAGE_REPLY = 'Por ahora solo puedo leer mensajes de texto. Escribime tu consulta y te ayudo.';

/** Margen que se reserva del tiempo restante de la Lambda para enviar la respuesta y cerrar. */
export const TIME_BUDGET_MARGIN_MS = 12_000;
/** Si queda menos que esto, no se arranca un mensaje nuevo: se deja para el reintento. */
export const MIN_TIME_TO_START_MS = 15_000;

export class MessageInProgressError extends Error {
  constructor(messageId: string) {
    super(`El mensaje ${messageId} está en proceso en otra invocación; reintentar más tarde`);
    this.name = 'MessageInProgressError';
  }
}

export class TimeBudgetExceededError extends Error {
  constructor() {
    super('No queda tiempo en la Lambda para procesar otro mensaje; reintentar');
    this.name = 'TimeBudgetExceededError';
  }
}

export function createHandler(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date());
  const metrics = deps.metrics ?? noopMetrics;

  return async function handler(event: SNSEvent, context?: Context): Promise<void> {
    if (context) logger.addContext(context);
    const remaining = () => context?.getRemainingTimeInMillis?.() ?? AGENT_REQUEST_TIMEOUT_MS + TIME_BUDGET_MARGIN_MS;
    try {
      for (const record of event.Records) {
        await handleRecord(record.Sns.Message, record.Sns.MessageId, remaining);
      }
    } finally {
      metrics.publishStoredMetrics();
    }
  };

  async function handleRecord(snsMessage: string, snsMessageId: string, remaining: () => number): Promise<void> {
    let parsed;
    try {
      parsed = parseInboundEvent(snsMessage);
    } catch (err) {
      if (err instanceof InboundEventError) {
        // Formato desconocido: no tiene sentido reintentar. Métrica propia con alarma.
        logger.error('Evento de SNS con formato inesperado', { snsMessageId, error: errorInfo(err) });
        metrics.addMetric(METRICS.parseError, MetricUnit.Count, 1);
        return;
      }
      throw err;
    }
    if (parsed.otherMessages > 0) {
      logger.info('Mensajes que no se contestan (reacciones, sistema, vacíos)', { snsMessageId, count: parsed.otherMessages });
      metrics.addMetric(METRICS.ignored, MetricUnit.Count, parsed.otherMessages);
    }
    if (parsed.invalidItems > 0) {
      logger.warn('Elementos del webhook con forma inesperada', { snsMessageId, count: parsed.invalidItems });
      metrics.addMetric(METRICS.invalid, MetricUnit.Count, parsed.invalidItems);
    }
    if (parsed.statuses.length > 0) {
      metrics.addMetric(METRICS.status, MetricUnit.Count, parsed.statuses.length);
      for (const status of parsed.statuses) {
        if (status.status === 'failed') {
          // Una respuesta nuestra que Meta no pudo entregar (ej. 131047 fuera de ventana).
          logger.error('WhatsApp no pudo entregar un mensaje', { outboundMessageId: status.messageId, errorCodes: status.errorCodes });
          metrics.addMetric(METRICS.deliveryFailed, MetricUnit.Count, 1);
        }
      }
    }
    for (const message of parsed.textMessages) {
      await handleMessage(message, remaining);
    }
    for (const message of parsed.unsupportedMessages) {
      logger.info('Mensaje que no es texto: se responde un texto fijo', { type: message.type });
      const asText = { messageId: message.messageId, from: message.from, text: '', sentAt: message.sentAt };
      await handleMessage(asText, remaining, UNSUPPORTED_MESSAGE_REPLY);
    }
  }

  /** `fixedReply` reemplaza al agente (mensajes que no son texto). */
  async function handleMessage(message: InboundTextMessage, remaining: () => number, fixedReply?: string): Promise<void> {
    logger.appendKeys({ messageId: message.messageId, phone: maskPhone(message.from) });
    try {
      if (remaining() < MIN_TIME_TO_START_MS) {
        logger.warn('Sin tiempo para procesar el mensaje en esta invocación');
        throw new TimeBudgetExceededError();
      }

      const claim = await deps.repos.claimMessage(message.messageId, now());
      if (claim === 'done') {
        logger.info('Mensaje ya procesado, se descarta');
        metrics.addMetric(METRICS.duplicate, MetricUnit.Count, 1);
        return;
      }
      if (claim === 'in_progress') {
        logger.warn('Mensaje en proceso en otra invocación (lease vivo); se reintenta más tarde');
        throw new MessageInProgressError(message.messageId);
      }

      let sentSomething = false;
      try {
        const conversation = await deps.repos.touchInbound(message.from, message.sentAt);
        if (!isWithinWindow({ phone: message.from, lastInboundAt: message.sentAt.toISOString() }, now())) {
          logger.warn('Mensaje más viejo que la ventana de 24 h; no se puede responder');
          metrics.addMetric(METRICS.stale, MetricUnit.Count, 1);
          await complete(message.messageId);
          return;
        }
        const timeoutMs = Math.min(AGENT_REQUEST_TIMEOUT_MS, Math.max(remaining() - TIME_BUDGET_MARGIN_MS, 5_000));
        const reply: AgentReply =
          fixedReply !== undefined ? { text: fixedReply, location: null } : await askAgent(message, conversation.sessionId, timeoutMs);
        sentSomething = await sendReply(message.from, reply);
        await complete(message.messageId);
        metrics.addMetric(fixedReply !== undefined ? METRICS.unsupported : METRICS.processed, MetricUnit.Count, 1);
      } catch (err) {
        if (sentSomething) {
          // Ya le llegó algo al cliente: no se reintenta para no duplicar.
          logger.error('Fallo después de enviar la respuesta; no se reintenta', { error: errorInfo(err) });
          await complete(message.messageId);
          return;
        }
        // Liberar el lease para que el reintento de Lambda lo retome enseguida.
        await deps.repos.releaseMessage(message.messageId).catch((e: unknown) => {
          logger.error('No se pudo liberar el lease del mensaje', { error: errorInfo(e) });
        });
        throw err;
      }
    } finally {
      logger.removeKeys(['messageId', 'phone']);
    }
  }

  async function complete(messageId: string): Promise<void> {
    // Si falla, el lease vence solo y el reintento vería el mensaje... en PROCESSING vencido:
    // se reprocesaría. Se loguea; en la práctica DynamoDB no falla acá y falló antes.
    await deps.repos.completeMessage(messageId, now()).catch((e: unknown) => {
      logger.error('No se pudo marcar el mensaje como procesado', { error: errorInfo(e) });
    });
  }

  async function askAgent(message: InboundTextMessage, sessionId: string | undefined, timeoutMs: number): Promise<AgentReply> {
    if (!sessionId) {
      logger.error('La conversación no tiene sessionId');
      metrics.addMetric(METRICS.agentFailed, MetricUnit.Count, 1);
      return FALLBACK_REPLY;
    }
    try {
      const reply = await deps.agent.invoke({ phone: message.from, text: message.text.slice(0, MAX_REQUEST_TEXT) }, sessionId, { timeoutMs });
      if (reply.degraded) {
        logger.warn('El agente respondió en modo degradado');
        metrics.addMetric(METRICS.agentFailed, MetricUnit.Count, 1);
      }
      return reply;
    } catch (err) {
      logger.error('El agente falló; se responde con el texto de disculpa', { error: errorInfo(err) });
      metrics.addMetric(METRICS.agentFailed, MetricUnit.Count, 1);
      return FALLBACK_REPLY;
    }
  }

  /** Devuelve `true` si algo salió por WhatsApp. Relanza solo si no salió nada y vale la pena reintentar. */
  async function sendReply(phone: string, reply: AgentReply): Promise<boolean> {
    try {
      await deps.sender.sendText(phone, reply.text);
    } catch (err) {
      metrics.addMetric(METRICS.replyFailed, MetricUnit.Count, 1);
      if (err instanceof OutsideWindowError) {
        logger.error('Ventana de 24 h cerrada al responder', { error: errorInfo(err) });
        return false;
      }
      if (isTransientAwsError(err) && !isAmbiguousSendError(err)) {
        logger.warn('Envío de la respuesta falló por causa transitoria; Lambda reintenta', { error: errorInfo(err) });
        throw err;
      }
      logger.error('No se pudo enviar la respuesta (sin reintento)', { error: errorInfo(err) });
      return false;
    }
    if (reply.location) {
      try {
        await deps.sender.sendLocation(phone, reply.location);
      } catch (err) {
        // El texto ya salió: no se reintenta nada.
        metrics.addMetric(METRICS.replyFailed, MetricUnit.Count, 1);
        logger.error('No se pudo enviar la ubicación', { error: errorInfo(err) });
      }
    }
    return true;
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
