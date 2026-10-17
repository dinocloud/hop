import { Agent, type Model } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { z } from 'zod';
import type { Repos } from '../../src/lib/dynamo.js';
import { createTools } from './tools.js';

/**
 * Agente de seguimiento para el cliente final. Responde "¿dónde está mi paquete?" con
 * estado, horarios y la ubicación del Punto HOP.
 *
 * Contrato de salida (lo consume la Lambda inbound): `{ text, location? }`. Si viene
 * `location`, la Lambda manda además un mensaje de ubicación de WhatsApp.
 */

export const AgentReplySchema = z.object({
  text: z.string().trim().min(1).max(4000).describe('Respuesta para el cliente, en español rioplatense, lista para WhatsApp'),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      name: z.string().trim().min(1).max(100),
      address: z.string().trim().min(1).max(200),
    })
    .nullable()
    .describe('Ubicación del Punto HOP cuando el paquete está listo para retirar; si no, null')
    .default(null),
});

export type AgentReply = z.infer<typeof AgentReplySchema>;

export const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-5-5';
export const MAX_TOKENS = 1024;

export const SYSTEM_PROMPT = `Sos el asistente de seguimiento de paquetes de HOP, una red de Puntos HOP (locales de barrio donde la gente retira sus paquetes) en Argentina. Hablás por WhatsApp.

Tu trabajo:
- Responder dónde está el paquete del cliente: estado, Punto HOP, dirección, horarios y fecha límite de retiro.
- Usar SIEMPRE las tools para consultar datos. Nunca inventes estados, direcciones, horarios ni fechas.
- Si el cliente no da un tracking, usá get_my_packages. Si tiene varios paquetes, resumí el más reciente y mencioná que hay otros.
- Si el paquete está READY_AT_HOP, consultá get_hop_point y devolvé la ubicación en el campo "location" para que le llegue el pin en el mapa. En otros estados "location" va en null.
- Si no encontrás paquetes para ese cliente, decilo y pedile el número de seguimiento.

Estados: IN_TRANSIT = en camino al Punto HOP; READY_AT_HOP = listo para retirar; DELIVERED = entregado; RETURNED = devuelto al remitente.

Estilo: español rioplatense (vos), cercano y corto, apto para WhatsApp: 2 a 5 líneas, sin markdown, sin emojis en exceso. Fechas en formato "viernes 17 de octubre". No pidas datos personales. No des información de paquetes que no sean del cliente. Si piden algo que no podés hacer (extender plazo, cambiar de punto, reprogramar, devolver), explicá que por ahora no podés y que pronto se va a poder desde este mismo chat.`;

export interface HopAgentDeps {
  repos: Repos;
  phone: string;
  model?: Model<never> | string;
  modelId?: string;
  region?: string;
}

export function createHopAgent(deps: HopAgentDeps): Agent {
  const model =
    deps.model ??
    new BedrockModel({
      modelId: deps.modelId ?? DEFAULT_MODEL_ID,
      maxTokens: MAX_TOKENS,
      temperature: 0.2,
      ...(deps.region ? { region: deps.region } : {}),
    });
  return new Agent({
    model: model as Model<never>,
    systemPrompt: SYSTEM_PROMPT,
    tools: createTools({ repos: deps.repos, phone: deps.phone }),
    printer: false,
  });
}

/** Pide la respuesta estructurada; si el modelo no la cumple, cae a texto plano sin ubicación. */
export async function askAgent(agent: Agent, text: string): Promise<AgentReply> {
  const result = await agent.invoke(text, { structuredOutputSchema: AgentReplySchema });
  const parsed = AgentReplySchema.safeParse(result.structuredOutput);
  if (parsed.success) return parsed.data;
  return parseReplyFallback(result.toString());
}

/** Fallback: intenta JSON embebido; si no, el texto crudo recortado. */
export function parseReplyFallback(raw: string): AgentReply {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const candidate = AgentReplySchema.safeParse(JSON.parse(trimmed.slice(start, end + 1)));
      if (candidate.success) return candidate.data;
    } catch {
      // no era JSON
    }
  }
  const text = trimmed.length > 0 ? trimmed.slice(0, 4000) : 'Perdón, no pude procesar tu consulta. ¿Me pasás el número de seguimiento?';
  return { text, location: null };
}
