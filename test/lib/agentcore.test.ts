import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentInvocationError, createAgentClient } from '../../src/lib/agentcore.js';

const agentcore = mockClient(BedrockAgentCoreClient);
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/hop_hackathon_agent-abc';
const SESSION = '0123456789abcdef0123456789abcdef0123';

function response(body: string, statusCode = 200) {
  return { statusCode, contentType: 'application/json', response: { transformToString: async () => body } };
}

describe('createAgentClient', () => {
  const client = createAgentClient({ client: new BedrockAgentCoreClient({}), agentRuntimeArn: ARN, retryDelaysMs: [0, 0, 0] });
  beforeEach(() => agentcore.reset());

  it('invoca el runtime con el payload del contrato y devuelve la respuesta validada', async () => {
    agentcore.on(InvokeAgentRuntimeCommand).resolves(response(JSON.stringify({ text: 'Listo en Palermo', location: { lat: -34.5, lng: -58.4, name: 'HOP', address: 'Calle 1' } })) as never);
    const reply = await client.invoke({ phone: '+5491112345678', text: 'hola' }, SESSION);
    expect(reply).toEqual({ text: 'Listo en Palermo', location: { lat: -34.5, lng: -58.4, name: 'HOP', address: 'Calle 1' } });
    const call = agentcore.commandCalls(InvokeAgentRuntimeCommand)[0]!;
    const input = call.args[0].input;
    expect(input).toMatchObject({ agentRuntimeArn: ARN, qualifier: 'DEFAULT', runtimeSessionId: SESSION, contentType: 'application/json' });
    expect(((call.args as unknown[])[1] as { abortSignal?: AbortSignal } | undefined)?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(new TextDecoder().decode(input.payload as Uint8Array))).toEqual({ phone: '+5491112345678', text: 'hola' });
  });

  it('rechaza session ids cortos sin llamar a AWS', async () => {
    await expect(client.invoke({ phone: '+5491112345678', text: 'hola' }, 'corto')).rejects.toThrow(AgentInvocationError);
    expect(agentcore.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('falla con AgentInvocationError si el runtime responde error, no JSON o fuera de contrato', async () => {
    agentcore.on(InvokeAgentRuntimeCommand).resolves(response('oops', 500) as never);
    await expect(client.invoke({ phone: '+5491112345678', text: 'hola' }, SESSION)).rejects.toThrow(/respondió 500/);
    agentcore.on(InvokeAgentRuntimeCommand).resolves(response('<html>') as never);
    await expect(client.invoke({ phone: '+5491112345678', text: 'hola' }, SESSION)).rejects.toThrow(/no devolvió JSON/);
    agentcore.on(InvokeAgentRuntimeCommand).resolves(response(JSON.stringify({ texto: 'x' })) as never);
    await expect(client.invoke({ phone: '+5491112345678', text: 'hola' }, SESSION)).rejects.toThrow(/contrato/);
  });

  it('propaga sin reintentar los errores que no son de sesión ocupada ni throttling', async () => {
    agentcore.on(InvokeAgentRuntimeCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(client.invoke({ phone: '+5491112345678', text: 'hola' }, SESSION)).rejects.toThrow('denied');
    expect(agentcore.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(1);
  });

  it('reintenta el 409 de una sesión que AgentCore todavía está levantando', async () => {
    agentcore
      .on(InvokeAgentRuntimeCommand)
      .rejectsOnce(
        Object.assign(new Error('Session operation in progress, please retry'), {
          name: 'RetryableConflictException',
          $metadata: { httpStatusCode: 409 },
        }),
      )
      .resolves(response(JSON.stringify({ text: 'ok', location: null })) as never);
    const reply = await client.invoke({ phone: '+5491112345678', text: 'hola' }, SESSION);
    expect(reply.text).toBe('ok');
    expect(agentcore.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(2);
  });

  it('se rinde después de agotar los reintentos de throttling', async () => {
    agentcore.on(InvokeAgentRuntimeCommand).rejects(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    await expect(client.invoke({ phone: '+5491112345678', text: 'hola' }, SESSION)).rejects.toThrow('slow down');
    expect(agentcore.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(4);
  });
});
