import { describe, expect, it, vi } from 'vitest';
import { AgentStoppedError, INVOKE_TIMEOUT_MS, MAX_TURNS, askAgent, parseModelReply, toAgentReply } from '../../agent/src/agent.js';
import { RequestSchema, createInvocationHandler } from '../../agent/src/index.js';
import { FALLBACK_REPLY } from '../../src/lib/agent-contract.js';
import type { Repos } from '../../src/lib/dynamo.js';
import type { HopPoint } from '../../src/lib/types.js';

const PHONE = '+5491112345678';
const palermo: HopPoint = { id: 'hop-palermo', name: 'Punto HOP Palermo', address: 'Av. Santa Fe 3253, CABA', lat: -34.5885, lng: -58.4106, openingHours: 'Lun a Vie 9 a 20' };
const getHopPoint = async (id: string) => (id === 'hop-palermo' ? palermo : undefined);

function fakeAgent(stopReason: string, text: string) {
  return { invoke: vi.fn(async () => ({ stopReason, toString: (): string => text })) };
}

describe('parseModelReply', () => {
  it('extrae el JSON del modelo aunque venga rodeado de texto', () => {
    expect(parseModelReply('Acá va: {"text":"Listo en Palermo","hopPointId":"hop-palermo"} gracias')).toEqual({
      text: 'Listo en Palermo',
      hopPointId: 'hop-palermo',
    });
    expect(parseModelReply('{"text":"En camino"}')).toEqual({ text: 'En camino', hopPointId: null });
  });
  it('usa el texto crudo si no hay JSON válido, y la disculpa si está vacío', () => {
    expect(parseModelReply('Tu paquete llega mañana.')).toEqual({ text: 'Tu paquete llega mañana.', hopPointId: null });
    expect(parseModelReply('{"text": 1}')).toEqual({ text: '{"text": 1}', hopPointId: null });
    expect(parseModelReply('   ')).toEqual({ text: FALLBACK_REPLY.text, hopPointId: null });
  });
});

describe('toAgentReply', () => {
  it('arma la ubicación desde DynamoDB, nunca desde el modelo', async () => {
    expect(await toAgentReply({ text: 'Listo', hopPointId: 'hop-palermo' }, { getHopPoint })).toEqual({
      text: 'Listo',
      location: { lat: -34.5885, lng: -58.4106, name: 'Punto HOP Palermo', address: 'Av. Santa Fe 3253, CABA' },
    });
  });
  it('un hopPointId desconocido o null no produce pin', async () => {
    expect((await toAgentReply({ text: 'x', hopPointId: 'hop-falso' }, { getHopPoint })).location).toBeNull();
    expect((await toAgentReply({ text: 'x', hopPointId: null }, { getHopPoint })).location).toBeNull();
  });
});

describe('askAgent', () => {
  it('invoca con límites y timeout y devuelve la respuesta del contrato', async () => {
    const agent = fakeAgent('endTurn', '{"text":"Listo en Palermo","hopPointId":"hop-palermo"}');
    const reply = await askAgent(agent, 'hola', { getHopPoint });
    expect(reply.text).toBe('Listo en Palermo');
    expect(reply.location?.name).toBe('Punto HOP Palermo');
    const [text, options] = agent.invoke.mock.calls[0] as unknown as [string, { limits: { turns: number }; cancelSignal: AbortSignal }];
    expect(text).toBe('hola');
    expect(options.limits).toEqual({ turns: MAX_TURNS });
    expect(options.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(INVOKE_TIMEOUT_MS).toBeLessThan(60_000);
  });
  it('si el agente no termina el turno (max_tokens, cancelación) lanza en vez de devolver basura', async () => {
    await expect(askAgent(fakeAgent('maxTokens', 'parcial'), 'hola', { getHopPoint })).rejects.toThrow(AgentStoppedError);
    await expect(askAgent(fakeAgent('cancelled', 'Cancelled by user'), 'hola', { getHopPoint })).rejects.toThrow(AgentStoppedError);
    await expect(askAgent(fakeAgent('limitTurns', 'parcial'), 'hola', { getHopPoint })).rejects.toThrow(AgentStoppedError);
  });
});

describe('createInvocationHandler', () => {
  const repos = { getHopPoint } as unknown as Repos;
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

  it('serializa los mensajes de una misma sesión y mantiene el orden', async () => {
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const ask = vi.fn(async (_agent: unknown, text: string) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      order.push(text);
      running -= 1;
      return { text, location: null };
    });
    const handle = createInvocationHandler({ repos, agentFactory: () => ({ invoke: vi.fn() }), ask });
    await Promise.all([
      handle({ phone: PHONE, text: 'hola' }, { sessionId: 's2' }),
      handle({ phone: PHONE, text: '¿dónde está mi paquete?' }, { sessionId: 's2' }),
    ]);
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['hola', '¿dónde está mi paquete?']);
  });

  it('si el agente falla responde la disculpa, descarta la sesión y el siguiente mensaje usa un agente nuevo', async () => {
    const agentFactory = vi.fn(() => ({ invoke: vi.fn() }));
    const ask = vi
      .fn<(agent: unknown, text: string) => Promise<{ text: string; location: null }>>()
      .mockRejectedValueOnce(new Error('Bedrock down'))
      .mockResolvedValueOnce({ text: 'ok', location: null });
    const handle = createInvocationHandler({ repos, agentFactory, ask });
    const first = await handle({ phone: PHONE, text: 'hola' }, { sessionId: 's3', log });
    expect(first).toEqual(FALLBACK_REPLY);
    expect(log.warn).toHaveBeenCalled();
    const second = await handle({ phone: PHONE, text: 'de nuevo' }, { sessionId: 's3', log });
    expect(second.text).toBe('ok');
    expect(agentFactory).toHaveBeenCalledTimes(2);
  });

  it('el log nunca lleva el teléfono completo', async () => {
    const handle = createInvocationHandler({ repos, agentFactory: () => ({ invoke: vi.fn() }), ask: async () => ({ text: 'ok', location: null }) });
    const localLog = { info: vi.fn(), warn: vi.fn() };
    await handle({ phone: PHONE, text: 'hola' }, { sessionId: 's4', log: localLog });
    expect(JSON.stringify(localLog.info.mock.calls)).not.toContain('12345678');
  });
});

describe('RequestSchema', () => {
  it('valida el payload de la Lambda inbound, incluido el formato E.164', () => {
    expect(RequestSchema.safeParse({ phone: PHONE, text: 'hola' }).success).toBe(true);
    expect(RequestSchema.safeParse({ phone: '5491112345678', text: 'hola' }).success).toBe(false);
    expect(RequestSchema.safeParse({ phone: 'abcdefghij', text: 'hola' }).success).toBe(false);
    expect(RequestSchema.safeParse({ phone: PHONE }).success).toBe(false);
    expect(RequestSchema.safeParse({ phone: PHONE, text: 'x'.repeat(5000) }).success).toBe(false);
  });
});
