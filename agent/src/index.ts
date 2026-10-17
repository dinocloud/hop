import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { createRepos, type Repos } from '../../src/lib/dynamo.js';
import { maskPhone, normalizePhone } from '../../src/lib/phone.js';
import { askAgent, createHopAgent, type AgentReply } from './agent.js';

/**
 * Entry point del runtime de AgentCore (deploy de código directo, NODE_22).
 *
 * `BedrockAgentCoreApp` levanta el servidor que exige el runtime (`POST /invocations`,
 * `GET /ping`, puerto 8080) y pasa el `sessionId` por contexto. AgentCore aísla cada sesión
 * en su propia instancia, así que un agente en memoria por sesión conserva el hilo de la
 * conversación mientras la sesión viva.
 *
 * Request:  { "phone": "+549...", "text": "¿dónde está mi paquete?" }
 * Response: { "text": "...", "location": { lat, lng, name, address } | null }
 */

export const RequestSchema = z.object({
  phone: z.string().trim().min(8).max(20),
  text: z.string().trim().min(1).max(4000),
});

export type AgentRequest = z.infer<typeof RequestSchema>;

export interface InvocationContext {
  sessionId: string;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

type InvokableAgent = Pick<ReturnType<typeof createHopAgent>, 'invoke'>;

export interface InvocationHandlerDeps {
  repos: Repos;
  modelId?: string;
  /** Fábrica del agente (inyectable en tests). */
  agentFactory?: (deps: { repos: Repos; phone: string; modelId?: string }) => InvokableAgent;
  ask?: (agent: InvokableAgent, text: string) => Promise<AgentReply>;
}

export function createInvocationHandler(deps: InvocationHandlerDeps) {
  const sessions = new Map<string, { phone: string; agent: InvokableAgent }>();
  const agentFactory = deps.agentFactory ?? createHopAgent;
  const ask = deps.ask ?? ((agent, text) => askAgent(agent as ReturnType<typeof createHopAgent>, text));

  return async function handle(request: AgentRequest, context: InvocationContext): Promise<AgentReply> {
    const phone = normalizePhone(request.phone);
    const key = context.sessionId || phone;

    let session = sessions.get(key);
    // Un sessionId es de un solo teléfono. Si cambia, se descarta el hilo anterior.
    if (!session || session.phone !== phone) {
      session = { phone, agent: agentFactory({ repos: deps.repos, phone, modelId: deps.modelId }) };
      sessions.set(key, session);
    }

    context.log?.info({ phone: maskPhone(phone), chars: request.text.length }, 'invocation');
    try {
      return await ask(session.agent, request.text);
    } catch (err) {
      context.log?.warn({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 'agent error');
      return {
        text: 'Perdón, tuve un problema para consultar tu paquete. Probá de nuevo en unos minutos.',
        location: null,
      };
    }
  };
}

export function main(): void {
  const repos = createRepos();
  const app = new BedrockAgentCoreApp({
    invocationHandler: {
      requestSchema: RequestSchema,
      process: createInvocationHandler({ repos, modelId: process.env.MODEL_ID }),
    },
  });
  app.run();
}

// Solo arranca el servidor cuando se ejecuta como entry point (no al importarlo en tests).
if (process.env.AGENTCORE_ENTRYPOINT !== 'false' && process.argv[1] && /index\.(js|ts)$/.test(process.argv[1])) {
  main();
}
