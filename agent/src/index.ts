import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { AgentRequestSchema, FALLBACK_REPLY, type AgentReply, type AgentRequest } from '../../src/lib/agent-contract.js';
import { createRepos, type Repos } from '../../src/lib/dynamo.js';
import { InvalidPhoneError, maskPhone, normalizePhone } from '../../src/lib/phone.js';
import { INVOKE_TIMEOUT_MS, askAgent, createHopAgent, hasPackageReadyAt, type InvokableAgent } from './agent.js';

/**
 * Servidor del runtime de AgentCore (deploy de código directo, NODE_22).
 *
 * `BedrockAgentCoreApp` levanta el servidor que exige el runtime (`POST /invocations`,
 * `GET /ping`, puerto 8080) y pasa el `sessionId` por contexto. AgentCore aísla cada sesión
 * en su propia instancia, así que un agente en memoria por sesión conserva el hilo de la
 * conversación mientras la sesión viva.
 *
 * Request:  { "phone": "+549...", "text": "¿dónde está mi paquete?" }
 * Response: { "text": "...", "location": { lat, lng, name, address } | null }
 *
 * El entry point del bundle es server.ts; este módulo se importa en los tests.
 */

/** El contrato más la validación E.164: un teléfono inválido es un 400, no un 500. */
export const RequestSchema = AgentRequestSchema.extend({
  phone: AgentRequestSchema.shape.phone.refine(
    (value: string) => {
      try {
        normalizePhone(value);
        return true;
      } catch (err) {
        if (err instanceof InvalidPhoneError) return false;
        throw err;
      }
    },
    { message: 'Teléfono inválido: se espera E.164 con +' },
  ),
});
export type { AgentRequest };

export interface InvocationContext {
  sessionId: string;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

/** Con menos tiempo que esto no vale la pena invocar al modelo: se responde la disculpa. */
export const MIN_AGENT_TIME_MS = 5_000;

export interface AskOptions {
  /** Teléfono de la sesión: decide de qué Puntos HOP se puede mandar el pin. */
  phone: string;
  /** Lo que queda del presupuesto, contado desde que llegó el pedido (incluye la cola). */
  timeoutMs: number;
}

export interface InvocationHandlerDeps {
  repos: Pick<Repos, 'getHopPoint' | 'getPackagesByPhone'> & Partial<Repos>;
  modelId?: string;
  /** Fábrica del agente (inyectable en tests). */
  agentFactory?: (deps: { repos: Repos; phone: string; modelId?: string }) => InvokableAgent;
  ask?: (agent: InvokableAgent, text: string, options: AskOptions) => Promise<AgentReply>;
  /** Reloj en ms (inyectable en tests). */
  now?: () => number;
}

export function createInvocationHandler(deps: InvocationHandlerDeps) {
  const sessions = new Map<string, { phone: string; agent: InvokableAgent }>();
  // Una sesión procesa de a un mensaje: dos mensajes seguidos del mismo cliente se encolan
  // (Strands rechaza invocar el mismo agente en paralelo).
  const queues = new Map<string, Promise<unknown>>();
  const agentFactory = deps.agentFactory ?? createHopAgent;
  const now = deps.now ?? Date.now;
  const ask =
    deps.ask ??
    ((agent, text, { phone, timeoutMs }) =>
      askAgent(agent, text, {
        getHopPoint: deps.repos.getHopPoint,
        canShowPin: (hopPointId) => hasPackageReadyAt(deps.repos, phone, hopPointId),
        timeoutMs,
      }));

  async function process(
    request: AgentRequest,
    context: InvocationContext,
    key: string,
    phone: string,
    deadline: number,
  ): Promise<AgentReply> {
    const timeoutMs = deadline - now();
    if (timeoutMs < MIN_AGENT_TIME_MS) {
      // El pedido esperó en la cola de la sesión: el cliente de la Lambda está por cortar.
      context.log?.warn({ remainingMs: timeoutMs }, 'sin tiempo para el agente después de la cola');
      return FALLBACK_REPLY;
    }
    let session = sessions.get(key);
    // Un sessionId es de un solo teléfono. Si cambia, se descarta el hilo anterior.
    if (!session || session.phone !== phone) {
      session = { phone, agent: agentFactory({ repos: deps.repos as Repos, phone, modelId: deps.modelId }) };
      sessions.set(key, session);
    }
    context.log?.info({ phone: maskPhone(phone), chars: request.text.length }, 'invocation');
    try {
      return await ask(session.agent, request.text, { phone, timeoutMs });
    } catch (err) {
      // El hilo queda inconsistente (turno de usuario sin respuesta): se descarta la sesión
      // para que el próximo mensaje arranque con un agente limpio.
      sessions.delete(key);
      context.log?.warn({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 'agent error');
      return FALLBACK_REPLY;
    }
  }

  return async function handle(request: AgentRequest, context: InvocationContext): Promise<AgentReply> {
    const phone = normalizePhone(request.phone);
    const key = context.sessionId || phone;
    const deadline = now() + INVOKE_TIMEOUT_MS;
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => process(request, context, key, phone, deadline));
    queues.set(key, run);
    try {
      return await run;
    } finally {
      if (queues.get(key) === run) queues.delete(key);
    }
  };
}

export function createApp(): BedrockAgentCoreApp<typeof RequestSchema> {
  const repos = createRepos();
  return new BedrockAgentCoreApp({
    invocationHandler: {
      requestSchema: RequestSchema,
      process: createInvocationHandler({ repos, modelId: process.env.MODEL_ID }),
    },
  });
}

export function main(): void {
  createApp().run();
}

// Para que los tests puedan construir el schema sin importar zod directamente.
export type RequestInput = z.input<typeof RequestSchema>;
