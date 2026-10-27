import type { Context, SNSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';
import { FALLBACK_REPLY } from '../../src/lib/agent-contract.js';
import type { AgentClient } from '../../src/lib/agentcore.js';
import type { Repos } from '../../src/lib/dynamo.js';
import { buildInboundEvent } from '../../src/lib/inbound-event.js';
import { OutsideWindowError, type WhatsAppSender } from '../../src/lib/whatsapp.js';
import {
  METRICS,
  MessageInProgressError,
  UNSUPPORTED_MESSAGE_REPLY,
  TimeBudgetExceededError,
  createHandler,
  type RouterMetrics,
} from '../../src/lambdas/inbound-router/handler.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const SENT_AT = new Date('2026-10-17T11:59:00Z');
const PHONE = '+5491112345678';
const SESSION = '0123456789abcdef0123456789abcdef0123';

function snsEvent(...messages: string[]): SNSEvent {
  return {
    Records: messages.map((message, i) => ({ EventSource: 'aws:sns', Sns: { Message: message, MessageId: `sns-${i}` } })),
  } as unknown as SNSEvent;
}

function inbound(text = '¿dónde está mi paquete?', messageId = 'wamid.A', sentAt = SENT_AT): string {
  return buildInboundEvent({ from: PHONE, text, messageId, sentAt });
}

/** Un entry con varios mensajes, como manda Meta. */
function multiInbound(...texts: string[]): string {
  const raw = JSON.parse(inbound(texts[0]!, 'wamid.1'));
  const entry = JSON.parse(raw.whatsAppWebhookEntry);
  entry.changes[0].value.messages = texts.map((text, i) => ({
    from: PHONE.slice(1),
    id: `wamid.${i + 1}`,
    timestamp: String(Math.floor(SENT_AT.getTime() / 1000)),
    type: 'text',
    text: { body: text },
  }));
  raw.whatsAppWebhookEntry = JSON.stringify(entry);
  return JSON.stringify(raw);
}

/** Un mensaje de otro tipo (audio, imagen...) con el formato de Meta. */
function mediaInbound(type: string, messageId = 'wamid.M'): string {
  const raw = JSON.parse(inbound('x', messageId));
  const entry = JSON.parse(raw.whatsAppWebhookEntry);
  entry.changes[0].value.messages = [
    { from: PHONE.slice(1), id: messageId, timestamp: String(Math.floor(SENT_AT.getTime() / 1000)), type, [type]: { id: 'media-1' } },
  ];
  raw.whatsAppWebhookEntry = JSON.stringify(entry);
  return JSON.stringify(raw);
}

function lambdaContext(remainingMs = 60_000): Context {
  return { getRemainingTimeInMillis: () => remainingMs } as unknown as Context;
}

function setup() {
  const repos = {
    claimMessage: vi.fn(async () => 'claimed' as const),
    touchInbound: vi.fn(async () => ({ phone: PHONE, lastInboundAt: SENT_AT.toISOString(), sessionId: SESSION })),
    completeMessage: vi.fn(async () => undefined),
    releaseMessage: vi.fn(async () => undefined),
  } as unknown as Repos;
  const agent = {
    invoke: vi.fn(async () => ({
      text: 'Tu paquete está en Palermo',
      location: { lat: -34.5, lng: -58.4, name: 'HOP Palermo', address: 'Calle 1' },
    })),
  } as unknown as AgentClient;
  const sender = {
    sendText: vi.fn(async () => ({ messageId: 'out.1' })),
    sendLocation: vi.fn(async () => ({ messageId: 'out.2' })),
  } as unknown as WhatsAppSender;
  const metrics: RouterMetrics = { addMetric: vi.fn(), publishStoredMetrics: vi.fn() };
  const handler = createHandler({ repos, agent, sender, metrics, now: () => NOW });
  const metricCalls = (name: string) => vi.mocked(metrics.addMetric).mock.calls.filter((c) => c[0] === name);
  return { repos, agent, sender, metrics, handler, metricCalls };
}

describe('inbound-router', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('a un audio o una imagen le contesta que por ahora solo lee texto, sin invocar al agente', async () => {
    await ctx.handler(snsEvent(mediaInbound('audio')), lambdaContext());
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
    expect(ctx.repos.claimMessage).toHaveBeenCalledWith('wamid.M', NOW);
    expect(ctx.repos.touchInbound).toHaveBeenCalledWith(PHONE, SENT_AT);
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, UNSUPPORTED_MESSAGE_REPLY);
    expect(ctx.sender.sendLocation).not.toHaveBeenCalled();
    expect(ctx.repos.completeMessage).toHaveBeenCalledWith('wamid.M', NOW);
    expect(ctx.metricCalls(METRICS.unsupported)).toEqual([[METRICS.unsupported, 'Count', 1]]);
  });

  it('camino feliz: reclama, abre la ventana con la fecha del mensaje, consulta al agente con presupuesto y responde texto + ubicación', async () => {
    await ctx.handler(snsEvent(inbound()), lambdaContext(60_000));
    expect(ctx.repos.claimMessage).toHaveBeenCalledWith('wamid.A', NOW);
    expect(ctx.repos.touchInbound).toHaveBeenCalledWith(PHONE, SENT_AT);
    expect(ctx.agent.invoke).toHaveBeenCalledWith({ phone: PHONE, text: '¿dónde está mi paquete?' }, SESSION, { timeoutMs: 40_000 });
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, 'Tu paquete está en Palermo');
    expect(ctx.sender.sendLocation).toHaveBeenCalledWith(PHONE, { lat: -34.5, lng: -58.4, name: 'HOP Palermo', address: 'Calle 1' });
    expect(ctx.repos.completeMessage).toHaveBeenCalledWith('wamid.A', NOW);
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(ctx.metricCalls(METRICS.processed)).toHaveLength(1);
    expect(ctx.metrics.publishStoredMetrics).toHaveBeenCalledTimes(1);
  });

  it('el timeout del agente se acota al tiempo que queda en la Lambda', async () => {
    await ctx.handler(snsEvent(inbound()), lambdaContext(30_000));
    expect(ctx.agent.invoke).toHaveBeenCalledWith(expect.anything(), SESSION, { timeoutMs: 18_000 });
  });

  it('sin tiempo para arrancar: no reclama y relanza para que el reintento lo tome', async () => {
    await expect(ctx.handler(snsEvent(inbound()), lambdaContext(10_000))).rejects.toThrow(TimeBudgetExceededError);
    expect(ctx.repos.claimMessage).not.toHaveBeenCalled();
  });

  it('sin ubicación solo manda texto', async () => {
    vi.mocked(ctx.agent.invoke).mockResolvedValueOnce({ text: 'En camino', location: null });
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, 'En camino');
    expect(ctx.sender.sendLocation).not.toHaveBeenCalled();
  });

  it('duplicado real (DONE): se descarta sin tocar el agente ni WhatsApp', async () => {
    vi.mocked(ctx.repos.claimMessage).mockResolvedValueOnce('done');
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.repos.touchInbound).not.toHaveBeenCalled();
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
    expect(ctx.sender.sendText).not.toHaveBeenCalled();
    expect(ctx.metricCalls(METRICS.duplicate)).toHaveLength(1);
  });

  it('lease vivo de otra invocación: relanza para reintentar más tarde en vez de perder el mensaje', async () => {
    vi.mocked(ctx.repos.claimMessage).mockResolvedValueOnce('in_progress');
    await expect(ctx.handler(snsEvent(inbound()))).rejects.toThrow(MessageInProgressError);
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(ctx.metrics.publishStoredMetrics).toHaveBeenCalledTimes(1);
  });

  it('mensaje más viejo que la ventana: no invoca al agente, completa y mide', async () => {
    await ctx.handler(snsEvent(inbound('viejo', 'wamid.old', new Date('2026-10-15T12:00:00Z'))));
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
    expect(ctx.sender.sendText).not.toHaveBeenCalled();
    expect(ctx.repos.completeMessage).toHaveBeenCalledWith('wamid.old', NOW);
    expect(ctx.metricCalls(METRICS.stale)).toHaveLength(1);
  });

  it('si el agente falla o responde degradado, manda la disculpa, completa y mide AgentFailed', async () => {
    vi.mocked(ctx.agent.invoke).mockRejectedValueOnce(new Error('runtime down'));
    await ctx.handler(snsEvent(inbound('a', 'wamid.a')));
    vi.mocked(ctx.agent.invoke).mockResolvedValueOnce(FALLBACK_REPLY);
    await ctx.handler(snsEvent(inbound('b', 'wamid.b')));
    expect(vi.mocked(ctx.sender.sendText).mock.calls.map((c) => c[1])).toEqual([FALLBACK_REPLY.text, FALLBACK_REPLY.text]);
    expect(ctx.repos.completeMessage).toHaveBeenCalledTimes(2);
    expect(ctx.metricCalls(METRICS.agentFailed)).toHaveLength(2);
  });

  it('texto largo: se trunca antes de invocar al agente', async () => {
    await ctx.handler(snsEvent(inbound('x'.repeat(4090), 'wamid.long')));
    const text = vi.mocked(ctx.agent.invoke).mock.calls[0]![0].text;
    expect(text).toHaveLength(4000);
  });

  it('envío transitorio antes de mandar nada: libera el lease y relanza', async () => {
    vi.mocked(ctx.sender.sendText).mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
    await expect(ctx.handler(snsEvent(inbound()))).rejects.toThrow('slow');
    expect(ctx.repos.releaseMessage).toHaveBeenCalledWith('wamid.A');
    expect(ctx.repos.completeMessage).not.toHaveBeenCalled();
    expect(ctx.metricCalls(METRICS.replyFailed)).toHaveLength(1);
  });

  it('timeout del envío (ambiguo): no reintenta, completa', async () => {
    vi.mocked(ctx.sender.sendText).mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(ctx.repos.completeMessage).toHaveBeenCalledTimes(1);
    expect(ctx.metricCalls(METRICS.replyFailed)).toHaveLength(1);
  });

  it('si falla la ubicación después del texto: no reintenta (el cliente ya recibió el texto)', async () => {
    vi.mocked(ctx.sender.sendLocation).mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.sender.sendText).toHaveBeenCalledTimes(1);
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(ctx.repos.completeMessage).toHaveBeenCalledTimes(1);
    expect(ctx.metricCalls(METRICS.replyFailed)).toHaveLength(1);
  });

  it('si falla completeMessage después de enviar: no se libera el lease ni se relanza', async () => {
    vi.mocked(ctx.repos.completeMessage).mockRejectedValueOnce(new Error('ddb down'));
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(ctx.sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('envío permanente o ventana cerrada: completa sin reintento y mide', async () => {
    vi.mocked(ctx.sender.sendText).mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ValidationException' }));
    await ctx.handler(snsEvent(inbound('a', 'wamid.P')));
    vi.mocked(ctx.sender.sendText).mockRejectedValueOnce(new OutsideWindowError(PHONE));
    await ctx.handler(snsEvent(inbound('b', 'wamid.W')));
    expect(ctx.repos.completeMessage).toHaveBeenCalledTimes(2);
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(ctx.metricCalls(METRICS.replyFailed)).toHaveLength(2);
  });

  it('si DynamoDB falla al abrir la conversación: libera el lease y relanza', async () => {
    vi.mocked(ctx.repos.touchInbound).mockRejectedValueOnce(new Error('ddb down'));
    await expect(ctx.handler(snsEvent(inbound()))).rejects.toThrow('ddb down');
    expect(ctx.repos.releaseMessage).toHaveBeenCalledWith('wamid.A');
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
  });

  it('statuses: se cuentan y un failed dispara ReplyDeliveryFailed; formato desconocido va a InboundParseError', async () => {
    const statuses = JSON.stringify({
      messageId: 'x',
      whatsAppWebhookEntry: JSON.stringify({
        changes: [
          {
            value: {
              statuses: [
                { id: 'wamid.s1', status: 'read' },
                { id: 'wamid.s2', status: 'failed', errors: [{ code: 131047 }] },
              ],
            },
          },
        ],
      }),
    });
    await ctx.handler(snsEvent(statuses, 'no json', JSON.stringify({ foo: 1 })));
    expect(ctx.repos.claimMessage).not.toHaveBeenCalled();
    expect(ctx.metricCalls(METRICS.status)[0]?.[2]).toBe(2);
    expect(ctx.metricCalls(METRICS.deliveryFailed)).toHaveLength(1);
    expect(ctx.metricCalls(METRICS.parseError)).toHaveLength(2);
  });

  it('varios mensajes en un mismo entry: en orden, y si el segundo falla el primero ya quedó completo', async () => {
    vi.mocked(ctx.repos.touchInbound)
      .mockResolvedValueOnce({ phone: PHONE, lastInboundAt: SENT_AT.toISOString(), sessionId: SESSION })
      .mockRejectedValueOnce(new Error('ddb down'));
    await expect(ctx.handler(snsEvent(multiInbound('uno', 'dos')))).rejects.toThrow('ddb down');
    expect(vi.mocked(ctx.agent.invoke).mock.calls.map((c) => c[0].text)).toEqual(['uno']);
    expect(ctx.repos.completeMessage).toHaveBeenCalledWith('wamid.1', NOW);
    expect(ctx.repos.releaseMessage).toHaveBeenCalledWith('wamid.2');
  });

  it('sin sessionId no invoca al agente: responde disculpa', async () => {
    vi.mocked(ctx.repos.touchInbound).mockResolvedValueOnce({ phone: PHONE });
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, FALLBACK_REPLY.text);
  });

  describe('contexto de los logs', () => {
    it('el camino feliz emite una línea con phone enmascarado y sessionId', async () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const keys = vi.spyOn(logger, 'appendKeys').mockImplementation(() => {});
      try {
        const ctx = setup();
        vi.mocked(ctx.agent.invoke).mockResolvedValueOnce({ text: 'Está en Palermo', location: null });
        await ctx.handler(snsEvent(inbound()), lambdaContext());

        // Sin esta línea, phone y sessionId quedan en el contexto sin emitirse nunca: una query
        // por teléfono solo encontraría las conversaciones que fallaron.
        expect(info).toHaveBeenCalledWith('Mensaje atendido', expect.anything());

        const applied = Object.assign({}, ...keys.mock.calls.map(([k]) => k));
        expect(applied.phone).toBe('***5678');
        expect(applied.phone).not.toContain('5491112345678');
        expect(applied.sessionId).toBe(SESSION);
      } finally {
        info.mockRestore();
        keys.mockRestore();
      }
    });
  });
});
