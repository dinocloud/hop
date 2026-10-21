import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging';
import { SDK_TIMEOUTS } from './aws-errors.js';
import { maskPhone, normalizePhone } from './phone.js';
import type { Conversation } from './types.js';
import { optionalEnv, requireEnv } from './types.js';

export { InvalidPhoneError, normalizePhone } from './phone.js';

/**
 * Envío de mensajes por AWS End User Messaging Social (WhatsApp).
 *
 * El body sigue el formato de la Cloud API de Meta y viaja como bytes en `message`.
 * Reglas que hay que respetar y que acá se hacen cumplir:
 * - El destino va en E.164 CON `+` (AWS lo exige; la Cloud API cruda de Meta lo quiere sin).
 * - Ventana de 24 h: texto libre y ubicación solo si el cliente escribió en las últimas 24 h.
 *   Fuera de la ventana solo se puede enviar una plantilla aprobada.
 */

/** AWS acepta la v20 en adelante; Meta retira cada versión unos dos años después de publicarla. */
export const DEFAULT_META_API_VERSION = 'v23.0';
const META_API_VERSION_PATTERN = /^v\d+\.\d+$/;
export const DEFAULT_TEMPLATE_LANGUAGE = 'es_AR';
export const WINDOW_HOURS = 24;
/** Margen de seguridad: la ventana local se cierra 5 min antes que la de Meta (reintentos, relojes). */
export const WINDOW_SAFETY_MINUTES = 5;
/** Límite de la Cloud API para el body de un mensaje de texto. */
export const MAX_TEXT_LENGTH = 4096;

export class OutsideWindowError extends Error {
  /** Teléfono enmascarado: este error termina en CloudWatch. */
  readonly phone: string;
  constructor(phone: string) {
    super('Fuera de la ventana de 24 h: solo se puede enviar una plantilla');
    this.name = 'OutsideWindowError';
    this.phone = maskPhone(phone);
  }
}

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
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
  /** Un texto largo se parte en varios mensajes: acá van todos los ids. */
  messageIds?: string[];
}

export interface WhatsAppSenderDeps {
  client?: SocialMessagingClient;
  /** ID de AWS del número (`phone-number-id-...`). Por defecto, env `ORIGINATION_PHONE_NUMBER_ID`. */
  originationPhoneNumberId?: string;
  /** Idioma de la plantilla. Por defecto env `TEMPLATE_LANGUAGE` o `es_AR`. */
  templateLanguage?: string;
  /** Versión de la Cloud API (`vN.N`). Por defecto env `META_API_VERSION` o `DEFAULT_META_API_VERSION`. */
  metaApiVersion?: string;
  /** Lee la conversación para evaluar la ventana de 24 h. */
  getConversation: (phone: string) => Promise<Conversation | undefined>;
  now?: () => Date;
}

export function isWithinWindow(conversation: Conversation | undefined, now: Date): boolean {
  if (!conversation?.lastInboundAt) return false;
  const last = Date.parse(conversation.lastInboundAt);
  if (Number.isNaN(last)) return false;
  const windowMs = (WINDOW_HOURS * 60 - WINDOW_SAFETY_MINUTES) * 60 * 1000;
  return now.getTime() - last < windowMs;
}

/** Parte un texto en bloques de hasta `max` caracteres cortando por salto de línea o espacio. */
export function chunkText(text: string, max = MAX_TEXT_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Meta rechaza parámetros de plantilla vacíos, con saltos de línea o tabs, o con más de 4
 * espacios seguidos (#132018). Se colapsa el espacio en blanco y se exige contenido.
 */
export function sanitizeTemplateParam(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) throw new InvalidMessageError('Parámetro de plantilla vacío');
  return clean;
}

export function createWhatsAppSender(deps: WhatsAppSenderDeps) {
  // Sin reintentos automáticos: SendWhatsAppMessage no es idempotente y un timeout después
  // de que AWS aceptó el mensaje duplicaría el envío. Los throttlings se ven en el log.
  const client = deps.client ?? new SocialMessagingClient({ maxAttempts: 1, requestHandler: { ...SDK_TIMEOUTS } });
  const originationPhoneNumberId = deps.originationPhoneNumberId ?? requireEnv('ORIGINATION_PHONE_NUMBER_ID');
  const templateLanguage = deps.templateLanguage ?? optionalEnv('TEMPLATE_LANGUAGE', DEFAULT_TEMPLATE_LANGUAGE);
  const metaApiVersion = deps.metaApiVersion ?? optionalEnv('META_API_VERSION', DEFAULT_META_API_VERSION);
  if (!META_API_VERSION_PATTERN.test(metaApiVersion)) {
    throw new Error(`META_API_VERSION inválida: "${metaApiVersion}" (formato vN.N, ej. ${DEFAULT_META_API_VERSION})`);
  }
  const now = deps.now ?? (() => new Date());

  async function send(body: Record<string, unknown>): Promise<string | undefined> {
    const res = await client.send(
      new SendWhatsAppMessageCommand({
        originationPhoneNumberId,
        metaApiVersion,
        message: new TextEncoder().encode(JSON.stringify(body)),
      }),
    );
    return res.messageId;
  }

  async function assertWindowOpen(phone: string): Promise<void> {
    const conversation = await deps.getConversation(phone);
    if (!isWithinWindow(conversation, now())) throw new OutsideWindowError(phone);
  }

  /** Texto libre. Requiere ventana de 24 h abierta. Textos largos se parten en varios mensajes. */
  async function sendText(rawPhone: string, text: string): Promise<SendResult> {
    const to = normalizePhone(rawPhone);
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new InvalidMessageError('Texto vacío');
    await assertWindowOpen(to);
    const messageIds: string[] = [];
    for (const body of chunks) {
      const id = await send({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      });
      if (id) messageIds.push(id);
    }
    return { messageId: messageIds[0], messageIds };
  }

  /** Plantilla aprobada en Meta. Es lo único que se puede enviar fuera de la ventana. */
  async function sendTemplate(
    rawPhone: string,
    templateName: string,
    bodyParams: string[],
    language = templateLanguage,
  ): Promise<SendResult> {
    const to = normalizePhone(rawPhone);
    const params = bodyParams.map(sanitizeTemplateParam);
    const components = params.length > 0 ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [];
    const messageId = await send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: templateName, language: { code: language }, components },
    });
    return { messageId };
  }

  /** Mensaje de ubicación (pin en el mapa). Requiere ventana de 24 h abierta. */
  async function sendLocation(rawPhone: string, location: Location): Promise<SendResult> {
    const to = normalizePhone(rawPhone);
    await assertWindowOpen(to);
    const messageId = await send({
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
    return { messageId };
  }

  return { sendText, sendTemplate, sendLocation };
}

export type WhatsAppSender = ReturnType<typeof createWhatsAppSender>;
