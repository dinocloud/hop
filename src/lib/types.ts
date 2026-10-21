/**
 * Modelo de datos compartido entre Lambdas, agente y scripts.
 * Las tablas DynamoDB se definen en infra/lib/hop-stack.ts.
 */

export const PACKAGE_STATUSES = ['IN_TRANSIT', 'READY_AT_HOP', 'DELIVERED', 'RETURNED'] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/** Tabla `hop-hackathon-packages`. PK `trackingId`. GSI `byPhone` (PK `phone`, SK `updatedAt`). */
export interface Package {
  trackingId: string;
  /** Teléfono del cliente en formato E.164 con `+` (ej. `+5491112345678`). */
  phone: string;
  customerName: string;
  status: PackageStatus;
  /** Punto HOP asignado. Obligatorio cuando `status = READY_AT_HOP`. */
  hopPointId?: string;
  /** Fecha límite de retiro, ISO 8601. Solo aplica en `READY_AT_HOP`. */
  deadlineAt?: string;
  /** Fecha reprogramada de entrega, ISO 8601. */
  scheduledAt?: string;
  updatedAt: string;
}

/** Tabla `hop-hackathon-hop-points`. PK `id`. */
export interface HopPoint {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** Texto corto, ej. "Lun a Vie 9 a 18, Sáb 9 a 13". */
  openingHours: string;
}

/** Tabla `hop-hackathon-conversations`. PK `phone`. */
export interface Conversation {
  phone: string;
  /** Último mensaje entrante del cliente, ISO 8601. Define la ventana de 24 h de WhatsApp. */
  lastInboundAt?: string;
  /** Session id para AgentCore Runtime (>= 33 caracteres). */
  sessionId?: string;
  /** Último `messageId` de WhatsApp procesado, para deduplicar reintentos. */
  lastMessageId?: string;
  lastTrackingId?: string;
}

/** Nombres de las variables de entorno que exponen la configuración a las Lambdas. */
export const ENV = {
  PACKAGES_TABLE: 'PACKAGES_TABLE',
  HOP_POINTS_TABLE: 'HOP_POINTS_TABLE',
  CONVERSATIONS_TABLE: 'CONVERSATIONS_TABLE',
  /** ID de AWS del número (`phone-number-id-...`), el `originationPhoneNumberId` de la API. No es el ID de Meta. */
  ORIGINATION_PHONE_NUMBER_ID: 'ORIGINATION_PHONE_NUMBER_ID',
  TEMPLATE_NAME: 'TEMPLATE_NAME',
  AGENT_RUNTIME_ARN: 'AGENT_RUNTIME_ARN',
  STAGE: 'STAGE',
} as const;

export function requireEnv(name: keyof typeof ENV): string {
  const value = process.env[ENV[name]];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${ENV[name]}`);
  }
  return value;
}
