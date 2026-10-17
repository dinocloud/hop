import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging';
import type { Conversation } from './types.js';
import { requireEnv } from './types.js';

/**
 * Envío de mensajes por AWS End User Messaging Social (WhatsApp).
 *
 * El body sigue el formato de la Cloud API de Meta y viaja como bytes en `message`.
 * Reglas que hay que respetar y que acá se hacen cumplir:
 * - El destino va en E.164 CON `+` (AWS lo exige; la Cloud API cruda de Meta lo quiere sin).
 * - Ventana de 24 h: texto libre y ubicación solo si el cliente escribió en las últimas 24 h.
 *   Fuera de la ventana solo se puede enviar una plantilla aprobada.
 */

export const META_API_VERSION = 'v20.0';
export const WINDOW_HOURS = 24;
export const DEFAULT_TEMPLATE_LANGUAGE = 'es_AR';

const E164 = /^\+[1-9]\d{7,14}$/;

export class InvalidPhoneError extends Error {
  constructor(readonly raw: string) {
    super('Teléfono inválido: se espera E.164 con +, por ejemplo +5491112345678');
    this.name = 'InvalidPhoneError';
  }
}

export class OutsideWindowError extends Error {
  constructor(readonly phone: string) {
    super('Fuera de la ventana de 24 h: solo se puede enviar una plantilla');
    this.name = 'OutsideWindowError';
  }
}

export interface Location {
  lat: number;
  lng: number;
  name: string;
  address: string;
}

export interface SendResult {
  messageId?: string;
}

export interface WhatsAppSenderDeps {
  client?: SocialMessagingClient;
  /** ID de AWS del número (`phone-number-id-...`). Por defecto, env `PHONE_NUMBER_ID`. */
  phoneNumberId?: string;
  /** Lee la conversación para evaluar la ventana de 24 h. */
  getConversation: (phone: string) => Promise<Conversation | undefined>;
  now?: () => Date;
}

/** `+54 9 11 1234-5678` → `+5491112345678`. Lanza `InvalidPhoneError` si no es E.164. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[\s().-]/g, '');
  const withPlus = digits.startsWith('+') ? digits : `+${digits}`;
  if (!E164.test(withPlus)) throw new InvalidPhoneError(raw);
  return withPlus;
}

export function isWithinWindow(conversation: Conversation | undefined, now: Date): boolean {
  if (!conversation?.lastInboundAt) return false;
  const last = Date.parse(conversation.lastInboundAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < WINDOW_HOURS * 60 * 60 * 1000;
}

export function createWhatsAppSender(deps: WhatsAppSenderDeps) {
  const client = deps.client ?? new SocialMessagingClient({});
  const phoneNumberId = deps.phoneNumberId ?? requireEnv('PHONE_NUMBER_ID');
  const now = deps.now ?? (() => new Date());

  async function send(body: Record<string, unknown>): Promise<SendResult> {
    const res = await client.send(
      new SendWhatsAppMessageCommand({
        originationPhoneNumberId: phoneNumberId,
        metaApiVersion: META_API_VERSION,
        message: new TextEncoder().encode(JSON.stringify(body)),
      }),
    );
    return { messageId: res.messageId };
  }

  async function assertWindowOpen(phone: string): Promise<void> {
    const conversation = await deps.getConversation(phone);
    if (!isWithinWindow(conversation, now())) throw new OutsideWindowError(phone);
  }

  /** Texto libre. Requiere ventana de 24 h abierta. */
  async function sendText(rawPhone: string, text: string): Promise<SendResult> {
    const to = normalizePhone(rawPhone);
    await assertWindowOpen(to);
    return send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    });
  }

  /** Plantilla aprobada en Meta. Es lo único que se puede enviar fuera de la ventana. */
  async function sendTemplate(
    rawPhone: string,
    templateName: string,
    bodyParams: string[],
    language = DEFAULT_TEMPLATE_LANGUAGE,
  ): Promise<SendResult> {
    const to = normalizePhone(rawPhone);
    const components =
      bodyParams.length > 0
        ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
        : [];
    return send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: templateName, language: { code: language }, components },
    });
  }

  /** Mensaje de ubicación (pin en el mapa). Requiere ventana de 24 h abierta. */
  async function sendLocation(rawPhone: string, location: Location): Promise<SendResult> {
    const to = normalizePhone(rawPhone);
    await assertWindowOpen(to);
    return send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'location',
      location: {
        latitude: location.lat,
        longitude: location.lng,
        name: location.name,
        address: location.address,
      },
    });
  }

  return { sendText, sendTemplate, sendLocation };
}

export type WhatsAppSender = ReturnType<typeof createWhatsAppSender>;
