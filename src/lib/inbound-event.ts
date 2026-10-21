import { z } from 'zod';
import { InvalidPhoneError, fromWaId } from './phone.js';

/**
 * Parseo del evento que AWS End User Messaging Social publica en SNS por cada webhook de
 * WhatsApp. El `Message` de SNS es un JSON con `whatsAppWebhookEntry`: el `entry` de la
 * Cloud API de Meta serializado como string. Un entry puede traer mensajes (`messages`) o
 * estados de entrega (`statuses`). Interesan:
 * - los mensajes de texto y los taps en botones (de plantilla o interactivos), que se tratan como texto;
 * - los mensajes de otro tipo que hay que contestar (audio, imagen...), para decir que solo se lee texto;
 * - los estados `failed`.
 *
 * Formato observado en la cuenta (statuses y messages comparten la estructura):
 * {
 *   "context": { "MetaWabaIds": [...], "MetaPhoneNumberIds": [...] },
 *   "messageId": "<uuid de AWS>",
 *   "whatsAppWebhookEntry": "{\"id\":\"<waba>\",\"changes\":[{\"value\":{\"messages\":[...]},\"field\":\"messages\"}]}",
 *   "aws_account_id": "...",
 *   "message_timestamp": "2026-10-14T21:16:20Z"
 * }
 *
 * El parser es tolerante por elemento: un mensaje o status con forma rara se cuenta como
 * inválido y no bloquea a los demás del mismo entry.
 */

const WebhookMessageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.coerce.number().int().positive(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    /** Tap en un botón de respuesta rápida de una plantilla. */
    button: z.object({ text: z.string() }).passthrough().optional(),
    interactive: z
      .object({
        button_reply: z.object({ title: z.string() }).passthrough().optional(),
        list_reply: z.object({ title: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type WebhookMessage = z.infer<typeof WebhookMessageSchema>;

/** Tipos que no se pueden leer pero merecen respuesta: el cliente mandó algo y espera que le contesten. */
const REPLY_TO_UNSUPPORTED_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts']);

const WebhookStatusSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    recipient_id: z.string().optional(),
    errors: z.array(z.object({ code: z.coerce.number().optional(), title: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const WebhookEntrySchema = z
  .object({
    id: z.string().optional(),
    changes: z
      .array(
        z
          .object({
            field: z.string().optional(),
            value: z
              .object({
                messages: z.array(z.unknown()).optional(),
                statuses: z.array(z.unknown()).optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const SocialMessagingEventSchema = z
  .object({
    messageId: z.string().optional(),
    whatsAppWebhookEntry: z.union([z.string(), WebhookEntrySchema]),
    message_timestamp: z.string().optional(),
  })
  .passthrough();

export interface InboundTextMessage {
  /** `id` del mensaje de WhatsApp (`wamid....`), único por mensaje. */
  messageId: string;
  /** Teléfono del cliente en E.164 con `+`. */
  from: string;
  text: string;
  /** Momento en que el cliente envió el mensaje (abre la ventana de 24 h). */
  sentAt: Date;
}

/** Mensaje que no es texto pero se contesta (con un texto fijo). */
export interface InboundUnsupportedMessage {
  messageId: string;
  /** Teléfono del cliente en E.164 con `+`. */
  from: string;
  /** Tipo de Meta: `audio`, `image`, `video`... */
  type: string;
  sentAt: Date;
}

export interface InboundStatus {
  /** `id` del mensaje saliente al que refiere. */
  messageId: string;
  status: string;
  /** Códigos de error de Meta cuando `status === 'failed'` (ej. 131047 re-engagement). */
  errorCodes: number[];
}

export interface ParsedInboundEvent {
  textMessages: InboundTextMessage[];
  /** Mensajes de otro tipo que reciben un texto fijo (ver `REPLY_TO_UNSUPPORTED_TYPES`). */
  unsupportedMessages: InboundUnsupportedMessage[];
  /** Mensajes que no se contestan: reacciones, mensajes de sistema, texto vacío. */
  otherMessages: number;
  /** Mensajes o statuses con forma inesperada o teléfono inválido. */
  invalidItems: number;
  statuses: InboundStatus[];
}

export class InboundEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundEventError';
  }
}

/** Parsea el `Message` de un registro SNS. Lanza `InboundEventError` si el sobre no tiene el formato esperado. */
export function parseInboundEvent(snsMessage: string): ParsedInboundEvent {
  let outer: unknown;
  try {
    outer = JSON.parse(snsMessage);
  } catch {
    throw new InboundEventError('El mensaje de SNS no es JSON');
  }
  const event = SocialMessagingEventSchema.safeParse(outer);
  if (!event.success) throw new InboundEventError('El mensaje de SNS no tiene whatsAppWebhookEntry');

  let entryRaw: unknown = event.data.whatsAppWebhookEntry;
  if (typeof entryRaw === 'string') {
    try {
      entryRaw = JSON.parse(entryRaw);
    } catch {
      throw new InboundEventError('whatsAppWebhookEntry no es JSON');
    }
  }
  const entry = WebhookEntrySchema.safeParse(entryRaw);
  if (!entry.success) throw new InboundEventError('whatsAppWebhookEntry no tiene el formato de la Cloud API');

  const result: ParsedInboundEvent = { textMessages: [], unsupportedMessages: [], otherMessages: 0, invalidItems: 0, statuses: [] };
  for (const change of entry.data.changes) {
    for (const rawStatus of change.value.statuses ?? []) {
      const status = WebhookStatusSchema.safeParse(rawStatus);
      if (!status.success) {
        result.invalidItems += 1;
        continue;
      }
      result.statuses.push({
        messageId: status.data.id,
        status: status.data.status,
        errorCodes: (status.data.errors ?? []).map((e) => e.code).filter((c): c is number => typeof c === 'number'),
      });
    }
    for (const rawMessage of change.value.messages ?? []) {
      const message = WebhookMessageSchema.safeParse(rawMessage);
      if (!message.success) {
        result.invalidItems += 1;
        continue;
      }
      const text = messageText(message.data);
      if (!text && !REPLY_TO_UNSUPPORTED_TYPES.has(message.data.type)) {
        result.otherMessages += 1;
        continue;
      }
      let from: string;
      try {
        from = fromWaId(message.data.from);
      } catch (err) {
        if (err instanceof InvalidPhoneError) {
          result.invalidItems += 1;
          continue;
        }
        throw err;
      }
      const sentAt = new Date(message.data.timestamp * 1000);
      if (text) result.textMessages.push({ messageId: message.data.id, from, text, sentAt });
      else result.unsupportedMessages.push({ messageId: message.data.id, from, type: message.data.type, sentAt });
    }
  }
  return result;
}

/** El texto de un mensaje, o lo que dice el botón que tocó el cliente. */
function messageText(message: WebhookMessage): string | undefined {
  let raw: string | undefined;
  if (message.type === 'text') raw = message.text?.body;
  else if (message.type === 'button') raw = message.button?.text;
  else if (message.type === 'interactive') raw = message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Arma un evento con el mismo formato, para tests y para `scripts/publish-inbound.ts`. */
export function buildInboundEvent(input: { from: string; text: string; messageId?: string; sentAt?: Date; wabaId?: string }): string {
  const sentAt = input.sentAt ?? new Date();
  const waId = input.from.replace(/^\+/, '');
  const entry = {
    id: input.wabaId ?? '0',
    changes: [
      {
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '0', phone_number_id: '0' },
          contacts: [{ wa_id: waId, profile: { name: 'Cliente' } }],
          messages: [
            {
              from: waId,
              id: input.messageId ?? `wamid.synthetic.${sentAt.getTime()}`,
              timestamp: String(Math.floor(sentAt.getTime() / 1000)),
              type: 'text',
              text: { body: input.text },
            },
          ],
        },
        field: 'messages',
      },
    ],
  };
  return JSON.stringify({
    context: { MetaWabaIds: [], MetaPhoneNumberIds: [] },
    messageId: `synthetic-${sentAt.getTime()}`,
    whatsAppWebhookEntry: JSON.stringify(entry),
    message_timestamp: sentAt.toISOString(),
  });
}
