import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { AgentReplySchema, type AgentReply, type AgentRequest } from './agent-contract.js';
import { requireEnv } from './types.js';

/**
 * Invocación del agente en AgentCore Runtime desde la Lambda inbound.
 * El `sessionId` (>= 33 caracteres) es el de la conversación: AgentCore mantiene el hilo.
 */

export class AgentInvocationError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}

export interface AgentClientDeps {
  client?: BedrockAgentCoreClient;
  agentRuntimeArn?: string;
  /** Endpoint del runtime. Por defecto `DEFAULT`. */
  qualifier?: string;
}

/** La Lambda inbound tiene 60 s: el agente tiene que responder bien antes. */
export const AGENT_REQUEST_TIMEOUT_MS = 40_000;

export function createAgentClient(deps: AgentClientDeps = {}) {
  const client =
    deps.client ??
    new BedrockAgentCoreClient({
      maxAttempts: 1,
      requestHandler: { requestTimeout: AGENT_REQUEST_TIMEOUT_MS, connectionTimeout: 1_000 },
    });
  const agentRuntimeArn = deps.agentRuntimeArn ?? requireEnv('AGENT_RUNTIME_ARN');
  const qualifier = deps.qualifier ?? 'DEFAULT';

  async function invoke(request: AgentRequest, sessionId: string): Promise<AgentReply> {
    if (sessionId.length < 33) throw new AgentInvocationError('sessionId demasiado corto para AgentCore (mínimo 33 caracteres)');
    const res = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn,
        qualifier,
        runtimeSessionId: sessionId,
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(request)),
      }),
    );
    const raw = (await res.response?.transformToString()) ?? '';
    if (res.statusCode !== undefined && res.statusCode >= 300) {
      throw new AgentInvocationError(`El runtime respondió ${res.statusCode}`, res.statusCode);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgentInvocationError('El runtime no devolvió JSON');
    }
    const reply = AgentReplySchema.safeParse(parsed);
    if (!reply.success) throw new AgentInvocationError('La respuesta del runtime no cumple el contrato');
    return reply.data;
  }

  return { invoke };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
