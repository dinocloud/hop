import { z } from 'zod';

/**
 * Contrato entre la Lambda inbound y el agente en AgentCore Runtime.
 * Lo importan los dos lados (src/lambdas y agent/src) para que no se desincronicen.
 */

export const AgentRequestSchema = z.object({
  /** Teléfono E.164 con `+` del cliente que escribe. */
  phone: z.string().trim().min(8).max(20),
  text: z.string().trim().min(1).max(4000),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

/** Largo máximo del texto que acepta el agente: la Lambda trunca antes de invocar. */
export const MAX_REQUEST_TEXT = 4000;

export const AgentLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(200),
});
export type AgentLocation = z.infer<typeof AgentLocationSchema>;

export const AgentReplySchema = z.object({
  text: z.string().trim().min(1).max(4000).describe('Respuesta para el cliente, en español rioplatense, lista para WhatsApp'),
  location: AgentLocationSchema.nullable()
    .describe('Ubicación del Punto HOP cuando el paquete está listo para retirar; si no, null')
    .default(null),
  /** `true` cuando el agente no pudo responder y el texto es la disculpa genérica. */
  degraded: z.boolean().optional(),
});
export type AgentReply = z.infer<typeof AgentReplySchema>;

export const FALLBACK_REPLY: AgentReply = {
  text: 'Perdón, tuve un problema para consultar tu paquete. Probá de nuevo en unos minutos.',
  location: null,
  degraded: true,
};
