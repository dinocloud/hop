/**
 * Modelo de datos compartido entre Lambdas, agente y scripts.
 * Las tablas DynamoDB se definen en infra/lib/hop-stack.ts.
 */

export const PACKAGE_STATUSES = ['IN_TRANSIT', 'READY_AT_HOP', 'DELIVERED', 'RETURNED'] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/**
 * Transiciones de estado permitidas. `DELIVERED` y `RETURNED` son terminales: un aviso
 * atrasado o repetido no puede "revivir" un paquete que el cliente ya retiró.
 */
export const ALLOWED_TRANSITIONS: Record<PackageStatus, readonly PackageStatus[]> = {
  IN_TRANSIT: ['IN_TRANSIT', 'READY_AT_HOP', 'DELIVERED', 'RETURNED'],
  READY_AT_HOP: ['READY_AT_HOP', 'IN_TRANSIT', 'DELIVERED', 'RETURNED'],
  DELIVERED: [],
  RETURNED: [],
};

export function canTransition(from: PackageStatus, to: PackageStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: PackageStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export type ReadyNotificationStatus = 'SENT' | 'FAILED';

/** Tabla `hop-hackathon-packages`. PK `trackingId`. GSI `byPhone` (PK `phone`, SK `updatedAt`). */
export interface Package {
  trackingId: string;
  /** Teléfono del cliente en formato E.164 con `+` (ej. `+5491112345678`). */
  phone: string;
  customerName: string;
  status: PackageStatus;
  /** Punto HOP asignado. Obligatorio cuando `status = READY_AT_HOP`. */
  hopPointId?: string;
  /** Fecha límite de retiro, ISO 8601 (fin del día N en Buenos Aires). Solo aplica en `READY_AT_HOP`. */
  deadlineAt?: string;
  /** Fecha reprogramada de entrega, ISO 8601. */
  scheduledAt?: string;
  /** Resultado del aviso "paquete listo" para el `hopPointId` actual. Evita avisar dos veces. */
  readyNotificationStatus?: ReadyNotificationStatus;
  readyNotifiedAt?: string;
  readyMessageId?: string;
  /** Nombre del error del último intento fallido (sin detalles sensibles). */
  readyNotificationError?: string;
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
  lastTrackingId?: string;
}

/**
 * Tabla `hop-hackathon-inbound-messages`. PK `messageId`. Un ítem por mensaje entrante de
 * WhatsApp, para procesar cada uno exactamente una vez aunque SNS/Lambda reintenten.
 * Se borra solo por TTL.
 */
export interface InboundMessage {
  messageId: string;
  status: 'PROCESSING' | 'DONE';
  /** Hasta cuándo vale el lease de PROCESSING (epoch segundos). Vencido, un reintento lo retoma. */
  leaseUntil: number;
  /** TTL de DynamoDB (epoch segundos). */
  expiresAt: number;
  updatedAt: string;
}

/** Nombres de las variables de entorno que exponen la configuración a las Lambdas. */
export const ENV = {
  PACKAGES_TABLE: 'PACKAGES_TABLE',
  HOP_POINTS_TABLE: 'HOP_POINTS_TABLE',
  CONVERSATIONS_TABLE: 'CONVERSATIONS_TABLE',
  INBOUND_MESSAGES_TABLE: 'INBOUND_MESSAGES_TABLE',
  /** ID de AWS del número (`phone-number-id-...`), el `originationPhoneNumberId` de la API. No es el ID de Meta. */
  ORIGINATION_PHONE_NUMBER_ID: 'ORIGINATION_PHONE_NUMBER_ID',
  TEMPLATE_NAME: 'TEMPLATE_NAME',
  /** Código de idioma con el que se aprobó la plantilla en Meta (ej. `es_AR`). */
  TEMPLATE_LANGUAGE: 'TEMPLATE_LANGUAGE',
  /** Versión de la Cloud API de Meta que se pasa a End User Messaging Social. */
  META_API_VERSION: 'META_API_VERSION',
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

export function optionalEnv(name: keyof typeof ENV, fallback: string): string {
  return process.env[ENV[name]] || fallback;
}
