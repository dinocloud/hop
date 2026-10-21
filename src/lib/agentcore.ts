import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { AgentReplySchema, type AgentReply, type AgentRequest } from './agent-contract.js';
import { errorName } from './aws-errors.js';
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
  /** Esperas entre reintentos ante una sesión ocupada (409) o throttling. */
  retryDelaysMs?: readonly number[];
}

export interface InvokeOptions {
  /** Tope de esta invocación. Por defecto `AGENT_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** La Lambda inbound tiene 60 s: el agente tiene que responder bien antes. */
export const AGENT_REQUEST_TIMEOUT_MS = 40_000;

/**
 * Errores en los que AgentCore no procesó el pedido, así que reintentar no duplica nada. El 409
 * (`RetryableConflictException`) aparece cuando la sesión se está levantando: dos mensajes
 * seguidos en el primer contacto, o después de 15 min sin actividad.
 */
const RETRYABLE_INVOKE_ERRORS = new Set(['RetryableConflictException', 'ThrottlingException']);
export const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000] as const;

export function createAgentClient(deps: AgentClientDeps = {}) {
  const client =
    deps.client ??
    new BedrockAgentCoreClient({
      maxAttempts: 1,
      requestHandler: { requestTimeout: AGENT_REQUEST_TIMEOUT_MS, connectionTimeout: 1_000 },
    });
  const agentRuntimeArn = deps.agentRuntimeArn ?? requireEnv('AGENT_RUNTIME_ARN');
  const qualifier = deps.qualifier ?? 'DEFAULT';
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  async function invoke(request: AgentRequest, sessionId: string, options: InvokeOptions = {}): Promise<AgentReply> {
    if (sessionId.length < 33) throw new AgentInvocationError('sessionId demasiado corto para AgentCore (mínimo 33 caracteres)');
    // Un solo timeout para todos los intentos: los reintentos no estiran el presupuesto.
    const signal = AbortSignal.timeout(options.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS);
    const res = await sendWithRetry(
      () =>
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn,
          qualifier,
          runtimeSessionId: sessionId,
          contentType: 'application/json',
          accept: 'application/json',
          payload: new TextEncoder().encode(JSON.stringify(request)),
        }),
      signal,
    );
    const raw = (await res.response?.transformToString()) ?? '';
    // Defensa: el SDK lanza ante un no-2xx, pero si alguna vez resolviera con error se trata igual.
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

  async function sendWithRetry(command: () => InvokeAgentRuntimeCommand, signal: AbortSignal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.send(command(), { abortSignal: signal });
      } catch (err) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined || signal.aborted || !RETRYABLE_INVOKE_ERRORS.has(errorName(err))) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return { invoke };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
