import { describe, expect, it } from 'vitest';
import { InboundEventError, buildInboundEvent, parseInboundEvent } from '../../src/lib/inbound-event.js';

/** Formato observado en la cuenta (status de entrega, sin mensajes). Datos ficticios. */
function statusEvent(statuses: unknown[]): string {
  return JSON.stringify({
    context: {
      MetaWabaIds: [{ wabaId: '1', arn: 'arn:aws:social-messaging:us-east-1:123456789012:waba/abc' }],
      MetaPhoneNumberIds: [{ metaPhoneNumberId: '2', arn: 'arn:aws:social-messaging:us-east-1:123456789012:phone-number-id/def' }],
    },
    messageId: '288fbe55-c75c-4389-8d3f-922c84dbf911',
    whatsAppWebhookEntry: JSON.stringify({
      id: '1',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '5491100000000', phone_number_id: '2' },
            contacts: [{ wa_id: '5491112345678', user_id: 'AR.1' }],
            statuses,
          },
          field: 'messages',
        },
      ],
    }),
    aws_account_id: '123456789012',
    message_timestamp: '2026-10-14T21:16:20.358868386Z',
  });
}

function textEvent(messages: unknown[]): string {
  return JSON.stringify({
    context: { MetaWabaIds: [], MetaPhoneNumberIds: [] },
    messageId: 'aws-1',
    whatsAppWebhookEntry: JSON.stringify({
      id: '1',
      changes: [{ value: { messaging_product: 'whatsapp', contacts: [{ wa_id: '5491112345678' }], messages }, field: 'messages' }],
    }),
    message_timestamp: '2026-10-17T12:00:00Z',
  });
}

const empty = { textMessages: [], otherMessages: 0, invalidItems: 0, statuses: [] };

describe('parseInboundEvent', () => {
  it('extrae los mensajes de texto con teléfono E.164 con + y fecha del mensaje', () => {
    const event = textEvent([
      { from: '5491112345678', id: 'wamid.A', timestamp: '1792238400', type: 'text', text: { body: '  ¿dónde está mi paquete?  ' } },
    ]);
    expect(parseInboundEvent(event)).toEqual({
      ...empty,
      textMessages: [
        { messageId: 'wamid.A', from: '+5491112345678', text: '¿dónde está mi paquete?', sentAt: new Date('2026-10-17T12:00:00.000Z') },
      ],
    });
  });

  it('acepta timestamp como número y whatsAppWebhookEntry ya parseado como objeto', () => {
    const raw = JSON.parse(textEvent([{ from: '5491112345678', id: 'wamid.E', timestamp: 1792238400, type: 'text', text: { body: 'hola' } }]));
    raw.whatsAppWebhookEntry = JSON.parse(raw.whatsAppWebhookEntry);
    const parsed = parseInboundEvent(JSON.stringify(raw));
    expect(parsed.textMessages).toHaveLength(1);
    expect(parsed.textMessages[0]?.sentAt.toISOString()).toBe('2026-10-17T12:00:00.000Z');
  });

  it('cuenta statuses y expone los failed con sus códigos', () => {
    const parsed = parseInboundEvent(
      statusEvent([
        { id: 'wamid.s1', status: 'sent', timestamp: '1792012579', recipient_id: '5491112345678' },
        { id: 'wamid.s2', status: 'failed', timestamp: '1792012580', errors: [{ code: 131047, title: 'Re-engagement message' }] },
      ]),
    );
    expect(parsed.textMessages).toEqual([]);
    expect(parsed.statuses).toEqual([
      { messageId: 'wamid.s1', status: 'sent', errorCodes: [] },
      { messageId: 'wamid.s2', status: 'failed', errorCodes: [131047] },
    ]);
  });

  it('ignora mensajes que no son de texto y cuenta los inválidos sin bloquear al resto', () => {
    const event = textEvent([
      { from: '5491112345678', id: 'wamid.B', timestamp: '1792238400', type: 'image', image: { id: 'x' } },
      { from: '5491112345678', id: 'wamid.C', timestamp: '1792238400', type: 'text', text: { body: '   ' } },
      { from: 'AR.1676497437424137', id: 'wamid.X', timestamp: '1792238400', type: 'text', text: { body: 'hola' } },
      { id: 'wamid.Y', type: 'text', text: { body: 'sin from ni timestamp' } },
      { from: '5491112345678', id: 'wamid.D', timestamp: '1792238401', type: 'text', text: { body: 'hola' } },
    ]);
    const parsed = parseInboundEvent(event);
    expect(parsed.otherMessages).toBe(2);
    expect(parsed.invalidItems).toBe(2);
    expect(parsed.textMessages.map((m) => m.messageId)).toEqual(['wamid.D']);
  });

  it('lanza InboundEventError solo ante sobres con formato desconocido', () => {
    expect(() => parseInboundEvent('no json')).toThrow(InboundEventError);
    expect(() => parseInboundEvent(JSON.stringify({ hello: 'world' }))).toThrow(InboundEventError);
    expect(() => parseInboundEvent(JSON.stringify({ whatsAppWebhookEntry: '{broken' }))).toThrow(InboundEventError);
    expect(() => parseInboundEvent(JSON.stringify({ whatsAppWebhookEntry: JSON.stringify({ changes: 'x' }) }))).toThrow(InboundEventError);
    expect(parseInboundEvent(JSON.stringify({ whatsAppWebhookEntry: JSON.stringify({ changes: [] }) }))).toEqual(empty);
  });
});

describe('buildInboundEvent', () => {
  it('genera un evento que el parser entiende (ida y vuelta)', () => {
    const sentAt = new Date('2026-10-17T12:00:00Z');
    const raw = buildInboundEvent({ from: '+5491112345678', text: 'hola', messageId: 'wamid.X', sentAt });
    expect(parseInboundEvent(raw).textMessages).toEqual([{ messageId: 'wamid.X', from: '+5491112345678', text: 'hola', sentAt }]);
  });
});
