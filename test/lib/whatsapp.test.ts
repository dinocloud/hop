import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Conversation } from '../../src/lib/types.js';
import {
  InvalidPhoneError,
  META_API_VERSION,
  OutsideWindowError,
  createWhatsAppSender,
  isWithinWindow,
  normalizePhone,
} from '../../src/lib/whatsapp.js';

const social = mockClient(SocialMessagingClient);
const NOW = new Date('2026-10-17T12:00:00Z');
const PHONE = '+5491112345678';

function lastSentBody(): Record<string, unknown> {
  const calls = social.commandCalls(SendWhatsAppMessageCommand);
  const input = calls.at(-1)?.args[0].input;
  if (!input?.message) throw new Error('no se envió nada');
  return JSON.parse(new TextDecoder().decode(input.message)) as Record<string, unknown>;
}

function senderWith(conversation: Conversation | undefined) {
  return createWhatsAppSender({
    client: new SocialMessagingClient({}),
    phoneNumberId: 'phone-number-id-test',
    getConversation: async () => conversation,
    now: () => NOW,
  });
}

const openWindow: Conversation = { phone: PHONE, lastInboundAt: '2026-10-17T11:00:00Z' };
const closedWindow: Conversation = { phone: PHONE, lastInboundAt: '2026-10-16T11:59:00Z' };

describe('normalizePhone', () => {
  it('agrega el + y limpia separadores', () => {
    expect(normalizePhone('5491112345678')).toBe(PHONE);
    expect(normalizePhone('+54 9 11 1234-5678')).toBe(PHONE);
    expect(normalizePhone('(+54) 911 1234 5678')).toBe(PHONE);
  });
  it('rechaza lo que no es E.164', () => {
    expect(() => normalizePhone('1234')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('+0123456789')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('hola')).toThrow(InvalidPhoneError);
  });
});

describe('isWithinWindow', () => {
  it('abierta si el último entrante tiene menos de 24 h', () => {
    expect(isWithinWindow(openWindow, NOW)).toBe(true);
    expect(isWithinWindow({ phone: PHONE, lastInboundAt: '2026-10-16T12:00:01Z' }, NOW)).toBe(true);
  });
  it('cerrada a las 24 h exactas, sin conversación o con fecha inválida', () => {
    expect(isWithinWindow({ phone: PHONE, lastInboundAt: '2026-10-16T12:00:00Z' }, NOW)).toBe(false);
    expect(isWithinWindow(closedWindow, NOW)).toBe(false);
    expect(isWithinWindow(undefined, NOW)).toBe(false);
    expect(isWithinWindow({ phone: PHONE, lastInboundAt: 'ayer' }, NOW)).toBe(false);
  });
});

describe('createWhatsAppSender', () => {
  beforeEach(() => {
    social.reset();
    social.on(SendWhatsAppMessageCommand).resolves({ messageId: 'wamid.123' });
  });

  it('sendText manda texto con el formato de la Cloud API y el destino con +', async () => {
    const result = await senderWith(openWindow).sendText('54 9 11 1234-5678', 'Hola Ana');
    expect(result.messageId).toBe('wamid.123');
    const input = social.commandCalls(SendWhatsAppMessageCommand)[0]?.args[0].input;
    expect(input?.originationPhoneNumberId).toBe('phone-number-id-test');
    expect(input?.metaApiVersion).toBe(META_API_VERSION);
    expect(lastSentBody()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: PHONE,
      type: 'text',
      text: { preview_url: false, body: 'Hola Ana' },
    });
  });

  it('sendText y sendLocation fallan fuera de la ventana sin llamar a AWS', async () => {
    const sender = senderWith(closedWindow);
    await expect(sender.sendText(PHONE, 'hola')).rejects.toThrow(OutsideWindowError);
    await expect(
      sender.sendLocation(PHONE, { lat: -34.5, lng: -58.4, name: 'HOP', address: 'Calle 1' }),
    ).rejects.toThrow(OutsideWindowError);
    expect(social.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
  });

  it('sendTemplate siempre pasa, con idioma es_AR y parámetros de body', async () => {
    await senderWith(undefined).sendTemplate(PHONE, 'paquete_listo', ['Ana', 'Punto HOP Palermo', '5']);
    expect(lastSentBody()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: PHONE,
      type: 'template',
      template: {
        name: 'paquete_listo',
        language: { code: 'es_AR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: 'Punto HOP Palermo' },
              { type: 'text', text: '5' },
            ],
          },
        ],
      },
    });
  });

  it('sendTemplate sin parámetros no manda components', async () => {
    await senderWith(undefined).sendTemplate(PHONE, 'hello_world', [], 'en_US');
    const body = lastSentBody() as { template: { components: unknown[]; language: { code: string } } };
    expect(body.template.components).toEqual([]);
    expect(body.template.language.code).toBe('en_US');
  });

  it('sendLocation manda lat/lng, nombre y dirección', async () => {
    await senderWith(openWindow).sendLocation(PHONE, {
      lat: -34.5885,
      lng: -58.4106,
      name: 'Punto HOP Palermo',
      address: 'Av. Santa Fe 3253, CABA',
    });
    expect(lastSentBody()).toMatchObject({
      type: 'location',
      location: { latitude: -34.5885, longitude: -58.4106, name: 'Punto HOP Palermo', address: 'Av. Santa Fe 3253, CABA' },
    });
  });

  it('propaga los errores de AWS', async () => {
    social.on(SendWhatsAppMessageCommand).rejects(new Error('Invalid destination phone number'));
    await expect(senderWith(openWindow).sendText(PHONE, 'hola')).rejects.toThrow('Invalid destination phone number');
  });

  it('rechaza teléfonos inválidos antes de llamar a AWS', async () => {
    await expect(senderWith(openWindow).sendText('1234', 'hola')).rejects.toThrow(InvalidPhoneError);
    expect(social.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
  });
});
