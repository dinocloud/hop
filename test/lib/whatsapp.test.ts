import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Conversation } from '../../src/lib/types.js';
import {
  DEFAULT_META_API_VERSION,
  InvalidMessageError,
  InvalidPhoneError,
  OutsideWindowError,
  chunkText,
  createWhatsAppSender,
  isWithinWindow,
  sanitizeTemplateParam,
} from '../../src/lib/whatsapp.js';

const social = mockClient(SocialMessagingClient);
const NOW = new Date('2026-10-17T12:00:00Z');
const PHONE = '+5491112345678';

function sentBodies(): Record<string, unknown>[] {
  return social.commandCalls(SendWhatsAppMessageCommand).map((call) => {
    const input = call.args[0].input;
    if (!input.message) throw new Error('mensaje vacío');
    return JSON.parse(new TextDecoder().decode(input.message)) as Record<string, unknown>;
  });
}

function senderWith(conversation: Conversation | undefined, extra: Record<string, string> = {}) {
  return createWhatsAppSender({
    client: new SocialMessagingClient({}),
    originationPhoneNumberId: 'phone-number-id-test',
    getConversation: async () => conversation,
    now: () => NOW,
    ...extra,
  });
}

const openWindow: Conversation = { phone: PHONE, lastInboundAt: '2026-10-17T11:00:00Z' };
const closedWindow: Conversation = { phone: PHONE, lastInboundAt: '2026-10-16T11:59:00Z' };

describe('isWithinWindow', () => {
  it('abierta si el último entrante tiene menos de 23 h 55 min (24 h menos el margen)', () => {
    expect(isWithinWindow(openWindow, NOW)).toBe(true);
    expect(isWithinWindow({ phone: PHONE, lastInboundAt: '2026-10-16T12:05:01Z' }, NOW)).toBe(true);
  });
  it('cerrada dentro del margen de 5 min, sin conversación o con fecha inválida', () => {
    expect(isWithinWindow({ phone: PHONE, lastInboundAt: '2026-10-16T12:05:00Z' }, NOW)).toBe(false);
    expect(isWithinWindow({ phone: PHONE, lastInboundAt: '2026-10-16T12:00:00Z' }, NOW)).toBe(false);
    expect(isWithinWindow(closedWindow, NOW)).toBe(false);
    expect(isWithinWindow(undefined, NOW)).toBe(false);
    expect(isWithinWindow({ phone: PHONE, lastInboundAt: 'ayer' }, NOW)).toBe(false);
  });
});

describe('chunkText', () => {
  it('deja intacto un texto corto y descarta el vacío', () => {
    expect(chunkText('hola')).toEqual(['hola']);
    expect(chunkText('   ')).toEqual([]);
  });
  it('corta por espacio o salto de línea sin pasarse del máximo', () => {
    const words = Array.from({ length: 50 }, (_, i) => `palabra${i}`).join(' ');
    const chunks = chunkText(words, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join(' ')).toBe(words);
  });
  it('corta duro si no hay separadores', () => {
    expect(chunkText('x'.repeat(250), 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });
});

describe('sanitizeTemplateParam', () => {
  it('colapsa espacios, tabs y saltos de línea', () => {
    expect(sanitizeTemplateParam('  Punto\tHOP\n   Palermo     ')).toBe('Punto HOP Palermo');
  });
  it('rechaza vacíos', () => {
    expect(() => sanitizeTemplateParam('  \n ')).toThrow(InvalidMessageError);
  });
});

describe('createWhatsAppSender', () => {
  beforeEach(() => {
    social.reset();
    social.on(SendWhatsAppMessageCommand).resolves({ messageId: 'wamid.123' });
  });

  it('sendText manda texto con el formato de la Cloud API y el destino con +', async () => {
    const result = await senderWith(openWindow).sendText('+54 9 11 1234-5678', 'Hola Ana');
    expect(result).toEqual({ messageId: 'wamid.123', messageIds: ['wamid.123'] });
    const input = social.commandCalls(SendWhatsAppMessageCommand)[0]?.args[0].input;
    expect(input?.originationPhoneNumberId).toBe('phone-number-id-test');
    expect(input?.metaApiVersion).toBe(DEFAULT_META_API_VERSION);
    expect(sentBodies()).toEqual([
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: PHONE,
        type: 'text',
        text: { preview_url: false, body: 'Hola Ana' },
      },
    ]);
  });

  it('sendText parte un texto largo en varios mensajes en orden', async () => {
    social.on(SendWhatsAppMessageCommand).resolvesOnce({ messageId: 'a' }).resolvesOnce({ messageId: 'b' });
    const long = `${'a'.repeat(4000)} ${'b'.repeat(4000)}`;
    const result = await senderWith(openWindow).sendText(PHONE, long);
    expect(result.messageIds).toEqual(['a', 'b']);
    const bodies = sentBodies() as Array<{ text: { body: string } }>;
    expect(bodies[0]?.text.body).toBe('a'.repeat(4000));
    expect(bodies[1]?.text.body).toBe('b'.repeat(4000));
  });

  it('sendText rechaza el texto vacío antes de llamar a AWS', async () => {
    await expect(senderWith(openWindow).sendText(PHONE, '  ')).rejects.toThrow(InvalidMessageError);
    expect(social.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
  });

  it('sendText y sendLocation fallan fuera de la ventana sin llamar a AWS, sin exponer el número', async () => {
    const sender = senderWith(closedWindow);
    await expect(sender.sendText(PHONE, 'hola')).rejects.toThrow(OutsideWindowError);
    await expect(
      sender.sendLocation(PHONE, { lat: -34.5, lng: -58.4, name: 'HOP', address: 'Calle 1' }),
    ).rejects.toThrow(OutsideWindowError);
    expect(social.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
    const err = (await sender.sendText(PHONE, 'hola').catch((e: unknown) => e)) as OutsideWindowError;
    expect(JSON.stringify(err)).not.toContain('12345678');
    expect(err.phone).toBe('***5678');
  });

  it('sendTemplate siempre pasa, con el idioma configurado y parámetros saneados', async () => {
    await senderWith(undefined).sendTemplate(PHONE, 'paquete_listo', ['Ana ', 'Punto HOP\nPalermo', '5']);
    expect(sentBodies()[0]).toEqual({
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

  it('sendTemplate toma el idioma de la dependencia o del argumento', async () => {
    await senderWith(undefined, { templateLanguage: 'es' }).sendTemplate(PHONE, 'paquete_listo', ['Ana', 'HOP', '1']);
    await senderWith(undefined).sendTemplate(PHONE, 'hello_world', [], 'en_US');
    const bodies = sentBodies() as Array<{ template: { components: unknown[]; language: { code: string } } }>;
    expect(bodies[0]?.template.language.code).toBe('es');
    expect(bodies[1]?.template.language.code).toBe('en_US');
    expect(bodies[1]?.template.components).toEqual([]);
  });

  it('sendTemplate rechaza un parámetro vacío antes de llamar a AWS', async () => {
    await expect(senderWith(undefined).sendTemplate(PHONE, 'paquete_listo', ['', 'HOP', '1'])).rejects.toThrow(
      InvalidMessageError,
    );
    expect(social.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
  });

  it('sendLocation manda lat/lng, nombre y dirección', async () => {
    await senderWith(openWindow).sendLocation(PHONE, {
      lat: -34.5885,
      lng: -58.4106,
      name: 'Punto HOP Palermo',
      address: 'Av. Santa Fe 3253, CABA',
    });
    expect(sentBodies()[0]).toMatchObject({
      type: 'location',
      location: { latitude: -34.5885, longitude: -58.4106, name: 'Punto HOP Palermo', address: 'Av. Santa Fe 3253, CABA' },
    });
  });

  it('propaga los errores de AWS', async () => {
    social.on(SendWhatsAppMessageCommand).rejects(new Error('Invalid destination phone number'));
    await expect(senderWith(openWindow).sendText(PHONE, 'hola')).rejects.toThrow('Invalid destination phone number');
  });

  it('rechaza teléfonos inválidos o sin + antes de llamar a AWS', async () => {
    await expect(senderWith(openWindow).sendText('1234', 'hola')).rejects.toThrow(InvalidPhoneError);
    await expect(senderWith(openWindow).sendText('5491112345678', 'hola')).rejects.toThrow(InvalidPhoneError);
    expect(social.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
  });
});

describe('versión de la Cloud API de Meta', () => {
  beforeEach(() => {
    social.reset();
    social.on(SendWhatsAppMessageCommand).resolves({ messageId: 'wamid.1' });
  });

  it('sin configuración manda una versión vigente de la Cloud API (v23.0)', async () => {
    await senderWith(openWindow).sendText(PHONE, 'hola');
    expect(social.commandCalls(SendWhatsAppMessageCommand)[0]?.args[0].input.metaApiVersion).toBe('v23.0');
  });

  it('rechaza una versión con formato inválido antes de llamar a AWS', () => {
    expect(() => senderWith(openWindow, { metaApiVersion: '23' })).toThrow(/META_API_VERSION/);
  });
});
