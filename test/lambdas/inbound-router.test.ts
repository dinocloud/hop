import type { SNSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_REPLY } from '../../src/lib/agent-contract.js';
import type { AgentClient } from '../../src/lib/agentcore.js';
import type { Repos } from '../../src/lib/dynamo.js';
import { buildInboundEvent } from '../../src/lib/inbound-event.js';
import { OutsideWindowError, type WhatsAppSender } from '../../src/lib/whatsapp.js';
import { METRICS, createHandler, type RouterMetrics } from '../../src/lambdas/inbound-router/handler.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const SENT_AT = new Date('2026-10-17T11:59:00Z');
const PHONE = '+5491112345678';
const SESSION = '0123456789abcdef0123456789abcdef0123';

function snsEvent(...messages: string[]): SNSEvent {
  return {
    Records: messages.map((Message, i) => ({
      EventSource: 'aws:sns',
      Sns: { Message, MessageId: `sns-${i}` },
    })),
  } as unknown as SNSEvent;
}

function inbound(text = '¿dónde está mi paquete?', messageId = 'wamid.A'): string {
  return buildInboundEvent({ from: PHONE, text, messageId, sentAt: SENT_AT });
}

function setup() {
  const repos = {
    claimMessage: vi.fn(async () => true),
    touchInbound: vi.fn(async () => ({ phone: PHONE, lastInboundAt: SENT_AT.toISOString(), sessionId: SESSION })),
    completeMessage: vi.fn(async () => undefined),
    releaseMessage: vi.fn(async () => undefined),
  } as unknown as Repos;
  const agent = {
    invoke: vi.fn(async () => ({ text: 'Tu paquete está en Palermo', location: { lat: -34.5, lng: -58.4, name: 'HOP Palermo', address: 'Calle 1' } })),
  } as unknown as AgentClient;
  const sender = {
    sendText: vi.fn(async () => ({ messageId: 'out.1' })),
    sendLocation: vi.fn(async () => ({ messageId: 'out.2' })),
  } as unknown as WhatsAppSender;
  const metrics: RouterMetrics = { addMetric: vi.fn(), publishStoredMetrics: vi.fn() };
  const handler = createHandler({ repos, agent, sender, metrics, now: () => NOW });
  return { repos, agent, sender, metrics, handler };
}

describe('inbound-router', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('camino feliz: reclama el mensaje, abre la ventana con la fecha del mensaje, consulta al agente y responde texto + ubicación', async () => {
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.repos.claimMessage).toHaveBeenCalledWith('wamid.A', NOW);
    expect(ctx.repos.touchInbound).toHaveBeenCalledWith(PHONE, SENT_AT);
    expect(ctx.agent.invoke).toHaveBeenCalledWith({ phone: PHONE, text: '¿dónde está mi paquete?' }, SESSION);
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, 'Tu paquete está en Palermo');
    expect(ctx.sender.sendLocation).toHaveBeenCalledWith(PHONE, { lat: -34.5, lng: -58.4, name: 'HOP Palermo', address: 'Calle 1' });
    expect(ctx.repos.completeMessage).toHaveBeenCalledWith('wamid.A', NOW);
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith(METRICS.processed, 'Count', 1);
    expect(ctx.metrics.publishStoredMetrics).toHaveBeenCalledTimes(1);
  });

  it('sin ubicación solo manda texto', async () => {
    vi.mocked(ctx.agent.invoke).mockResolvedValueOnce({ text: 'En camino', location: null });
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, 'En camino');
    expect(ctx.sender.sendLocation).not.toHaveBeenCalled();
  });

  it('descarta duplicados sin tocar el agente ni WhatsApp', async () => {
    vi.mocked(ctx.repos.claimMessage).mockResolvedValueOnce(false);
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.repos.touchInbound).not.toHaveBeenCalled();
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
    expect(ctx.sender.sendText).not.toHaveBeenCalled();
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith(METRICS.duplicate, 'Count', 1);
  });

  it('si el agente falla, responde el texto de disculpa y completa el mensaje', async () => {
    vi.mocked(ctx.agent.invoke).mockRejectedValueOnce(new Error('runtime down'));
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, FALLBACK_REPLY.text);
    expect(ctx.sender.sendLocation).not.toHaveBeenCalled();
    expect(ctx.repos.completeMessage).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith(METRICS.agentFailed, 'Count', 1);
  });

  it('si el envío falla por causa transitoria: libera el lease y relanza para que Lambda reintente', async () => {
    vi.mocked(ctx.sender.sendText).mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
    await expect(ctx.handler(snsEvent(inbound()))).rejects.toThrow('slow');
    expect(ctx.repos.releaseMessage).toHaveBeenCalledWith('wamid.A');
    expect(ctx.repos.completeMessage).not.toHaveBeenCalled();
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith(METRICS.replyFailed, 'Count', 1);
    expect(ctx.metrics.publishStoredMetrics).toHaveBeenCalledTimes(1);
  });

  it('si el envío falla de forma permanente o por ventana cerrada: no reintenta, completa y lo deja en la métrica', async () => {
    vi.mocked(ctx.sender.sendText).mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ValidationException' }));
    await ctx.handler(snsEvent(inbound('a', 'wamid.P')));
    vi.mocked(ctx.sender.sendText).mockRejectedValueOnce(new OutsideWindowError(PHONE));
    await ctx.handler(snsEvent(inbound('b', 'wamid.W')));
    expect(ctx.repos.completeMessage).toHaveBeenCalledTimes(2);
    expect(ctx.repos.releaseMessage).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.metrics.addMetric).mock.calls.filter((c) => c[0] === METRICS.replyFailed)).toHaveLength(2);
  });

  it('si DynamoDB falla al abrir la conversación: libera el lease y relanza', async () => {
    vi.mocked(ctx.repos.touchInbound).mockRejectedValueOnce(new Error('ddb down'));
    await expect(ctx.handler(snsEvent(inbound()))).rejects.toThrow('ddb down');
    expect(ctx.repos.releaseMessage).toHaveBeenCalledWith('wamid.A');
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
  });

  it('eventos de status o con formato desconocido no rompen ni reintentan', async () => {
    const status = JSON.stringify({ messageId: 'x', whatsAppWebhookEntry: JSON.stringify({ changes: [{ value: { statuses: [{}] } }] }) });
    await ctx.handler(snsEvent(status, 'no json', JSON.stringify({ foo: 1 })));
    expect(ctx.repos.claimMessage).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.metrics.addMetric).mock.calls.filter((c) => c[0] === METRICS.ignored)).toHaveLength(2);
  });

  it('procesa varios mensajes y registros en orden', async () => {
    await ctx.handler(snsEvent(inbound('uno', 'wamid.1'), inbound('dos', 'wamid.2')));
    expect(vi.mocked(ctx.agent.invoke).mock.calls.map((c) => c[0].text)).toEqual(['uno', 'dos']);
    expect(ctx.repos.completeMessage).toHaveBeenCalledTimes(2);
  });

  it('sin sessionId no invoca al agente: responde disculpa', async () => {
    vi.mocked(ctx.repos.touchInbound).mockResolvedValueOnce({ phone: PHONE });
    await ctx.handler(snsEvent(inbound()));
    expect(ctx.agent.invoke).not.toHaveBeenCalled();
    expect(ctx.sender.sendText).toHaveBeenCalledWith(PHONE, FALLBACK_REPLY.text);
  });
});
