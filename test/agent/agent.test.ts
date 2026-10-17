import { describe, expect, it, vi } from 'vitest';
import { AgentReplySchema, askAgent, parseReplyFallback } from '../../agent/src/agent.js';
import { createInvocationHandler, RequestSchema } from '../../agent/src/index.js';
import type { Repos } from '../../src/lib/dynamo.js';

const PHONE = '+5491112345678';

describe('AgentReplySchema', () => {
  it('acepta texto con ubicación o con null', () => {
    expect(AgentReplySchema.parse({ text: 'Hola' })).toEqual({ text: 'Hola', location: null });
    expect(
      AgentReplySchema.parse({ text: 'Listo', location: { lat: -34.5, lng: -58.4, name: 'HOP', address: 'Calle 1' } }).location,
    ).toMatchObject({ name: 'HOP' });
  });
  it('rechaza texto vacío y coordenadas fuera de rango', () => {
    expect(AgentReplySchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(AgentReplySchema.safeParse({ text: 'x', location: { lat: 100, lng: 0, name: 'a', address: 'b' } }).success).toBe(false);
  });
});

describe('parseReplyFallback', () => {
  it('extrae JSON embebido si cumple el contrato', () => {
    expect(parseReplyFallback('Acá va: {"text":"Tu paquete está listo","location":null} gracias')).toEqual({
      text: 'Tu paquete está listo',
      location: null,
    });
  });
  it('usa el texto crudo si no hay JSON válido, y un mensaje de disculpa si está vacío', () => {
    expect(parseReplyFallback('Tu paquete llega mañana.')).toEqual({ text: 'Tu paquete llega mañana.', location: null });
    expect(parseReplyFallback('{"text": 1}')).toEqual({ text: '{"text": 1}', location: null });
    expect(parseReplyFallback('   ').text).toMatch(/número de seguimiento/);
  });
});

describe('askAgent', () => {
  it('prefiere la salida estructurada y cae a texto si no cumple el contrato', async () => {
    const structured = { invoke: vi.fn(async () => ({ structuredOutput: { text: 'ok', location: null }, toString: (): string => 'ok' })) };
    expect(await askAgent(structured as never, 'hola')).toEqual({ text: 'ok', location: null });
    expect(structured.invoke).toHaveBeenCalledWith('hola', { structuredOutputSchema: AgentReplySchema });

    const plain = { invoke: vi.fn(async () => ({ structuredOutput: undefined, toString: (): string => 'texto plano' })) };
    expect(await askAgent(plain as never, 'hola')).toEqual({ text: 'texto plano', location: null });
  });
});

describe('createInvocationHandler', () => {
  const repos = {} as Repos;
  const log = { info: vi.fn(), warn: vi.fn() };

  it('crea un agente por sesión y lo reutiliza; un cambio de teléfono descarta el hilo', async () => {
    const agentFactory = vi.fn(() => ({ invoke: vi.fn() }));
    const ask = vi.fn(async (_agent: unknown, text: string) => ({ text: `eco: ${text}`, location: null }));
    const handle = createInvocationHandler({ repos, agentFactory, ask });

    expect(await handle({ phone: PHONE, text: 'hola' }, { sessionId: 's1', log })).toEqual({ text: 'eco: hola', location: null });
    await handle({ phone: '+54 9 11 1234-5678', text: 'otra' }, { sessionId: 's1', log });
    expect(agentFactory).toHaveBeenCalledTimes(1);
    expect(agentFactory).toHaveBeenCalledWith({ repos, phone: PHONE, modelId: undefined });

    await handle({ phone: '+5491187654321', text: 'x' }, { sessionId: 's1', log });
    expect(agentFactory).toHaveBeenCalledTimes(2);
  });

  it('no deja caer la invocación si el agente falla: responde un texto de disculpa', async () => {
    const handle = createInvocationHandler({
      repos,
      agentFactory: () => ({ invoke: vi.fn() }),
      ask: async () => {
        throw new Error('Bedrock down');
      },
    });
    const reply = await handle({ phone: PHONE, text: 'hola' }, { sessionId: 's2', log });
    expect(reply.location).toBeNull();
    expect(reply.text).toMatch(/Probá de nuevo/);
    expect(log.warn).toHaveBeenCalled();
  });

  it('rechaza teléfonos inválidos', async () => {
    const handle = createInvocationHandler({ repos, agentFactory: () => ({ invoke: vi.fn() }), ask: vi.fn() });
    await expect(handle({ phone: '1234', text: 'hola' }, { sessionId: 's3' })).rejects.toThrow();
  });

  it('el log nunca lleva el teléfono completo', async () => {
    const handle = createInvocationHandler({ repos, agentFactory: () => ({ invoke: vi.fn() }), ask: async () => ({ text: 'ok', location: null }) });
    const localLog = { info: vi.fn(), warn: vi.fn() };
    await handle({ phone: PHONE, text: 'hola' }, { sessionId: 's4', log: localLog });
    expect(JSON.stringify(localLog.info.mock.calls)).not.toContain('12345678');
  });
});

describe('RequestSchema', () => {
  it('valida el payload de la Lambda inbound', () => {
    expect(RequestSchema.safeParse({ phone: PHONE, text: 'hola' }).success).toBe(true);
    expect(RequestSchema.safeParse({ phone: PHONE }).success).toBe(false);
    expect(RequestSchema.safeParse({ phone: PHONE, text: 'x'.repeat(5000) }).success).toBe(false);
  });
});
