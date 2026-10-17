import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { normalizePhone } from './phone.js';
import type { Conversation, HopPoint, InboundMessage, Package, PackageStatus } from './types.js';
import { requireEnv } from './types.js';

export interface TableNames {
  packages: string;
  hopPoints: string;
  conversations: string;
  inboundMessages: string;
}

export interface ReposDeps {
  doc?: DynamoDBDocumentClient;
  tables?: TableNames;
}

export interface PackageStatusPatch {
  status: PackageStatus;
  hopPointId?: string;
  deadlineAt?: string;
  scheduledAt?: string;
}

/** Lease de procesamiento de un mensaje entrante. Más largo que el timeout de la Lambda (60 s). */
export const MESSAGE_LEASE_SECONDS = 120;
/** Los ítems de dedupe se borran solos a los 7 días. */
export const MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60;

export class PackageNotFoundError extends Error {
  constructor(readonly trackingId: string) {
    super(`No existe el paquete ${trackingId}`);
    this.name = 'PackageNotFoundError';
  }
}

export function tableNamesFromEnv(): TableNames {
  return {
    packages: requireEnv('PACKAGES_TABLE'),
    hopPoints: requireEnv('HOP_POINTS_TABLE'),
    conversations: requireEnv('CONVERSATIONS_TABLE'),
    inboundMessages: requireEnv('INBOUND_MESSAGES_TABLE'),
  };
}

export function createDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * Acceso tipado a las tablas. Cada Lambda crea una instancia fuera del handler
 * (reutiliza la conexión entre invocaciones) e inyecta mocks en los tests.
 * Todo teléfono que entra se normaliza a E.164 con `+`, así las claves son únicas.
 */
export function createRepos(deps: ReposDeps = {}) {
  const doc = deps.doc ?? createDocumentClient();
  const tables = deps.tables ?? tableNamesFromEnv();

  async function getPackage(trackingId: string): Promise<Package | undefined> {
    const res = await doc.send(new GetCommand({ TableName: tables.packages, Key: { trackingId } }));
    return res.Item as Package | undefined;
  }

  /** Paquetes de un teléfono, el más reciente primero. */
  async function getPackagesByPhone(rawPhone: string, limit = 5): Promise<Package[]> {
    const phone = normalizePhone(rawPhone);
    const res = await doc.send(
      new QueryCommand({
        TableName: tables.packages,
        IndexName: 'byPhone',
        KeyConditionExpression: '#phone = :phone',
        ExpressionAttributeNames: { '#phone': 'phone' },
        ExpressionAttributeValues: { ':phone': phone },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []) as Package[];
  }

  /** Actualiza el estado y devuelve el paquete completo. Lanza `PackageNotFoundError` si no existe. */
  async function updatePackageStatus(trackingId: string, patch: PackageStatusPatch, now = new Date()): Promise<Package> {
    const sets: string[] = ['#status = :status', '#updatedAt = :updatedAt'];
    const removes: string[] = [];
    const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = { ':status': patch.status, ':updatedAt': now.toISOString() };

    for (const field of ['hopPointId', 'deadlineAt', 'scheduledAt'] as const) {
      const value = patch[field];
      if (value !== undefined) {
        names[`#${field}`] = field;
        sets.push(`#${field} = :${field}`);
        values[`:${field}`] = value;
      } else if (field !== 'hopPointId') {
        // Un cambio de estado invalida plazos y reprogramaciones anteriores. El Punto HOP se conserva.
        names[`#${field}`] = field;
        removes.push(`#${field}`);
      }
    }

    const input: UpdateCommandInput = {
      TableName: tables.packages,
      Key: { trackingId },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ConditionExpression: 'attribute_exists(trackingId)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };

    try {
      const res = await doc.send(new UpdateCommand(input));
      return res.Attributes as Package;
    } catch (err) {
      if (isConditionalCheckFailed(err)) throw new PackageNotFoundError(trackingId);
      throw err;
    }
  }

  async function getHopPoint(id: string): Promise<HopPoint | undefined> {
    const res = await doc.send(new GetCommand({ TableName: tables.hopPoints, Key: { id } }));
    return res.Item as HopPoint | undefined;
  }

  /** Lectura fuertemente consistente: se consulta justo después de `touchInbound`. */
  async function getConversation(rawPhone: string): Promise<Conversation | undefined> {
    const phone = normalizePhone(rawPhone);
    const res = await doc.send(new GetCommand({ TableName: tables.conversations, Key: { phone }, ConsistentRead: true }));
    return res.Item as Conversation | undefined;
  }

  /**
   * Registra un mensaje entrante: renueva la ventana de 24 h con la fecha del mensaje y asigna
   * `sessionId` si no existía. Devuelve la conversación resultante.
   */
  async function touchInbound(rawPhone: string, inboundAt: Date): Promise<Conversation> {
    const phone = normalizePhone(rawPhone);
    const res = await doc.send(
      new UpdateCommand({
        TableName: tables.conversations,
        Key: { phone },
        UpdateExpression: 'SET #lastInboundAt = :inboundAt, #sessionId = if_not_exists(#sessionId, :sessionId)',
        ExpressionAttributeNames: { '#lastInboundAt': 'lastInboundAt', '#sessionId': 'sessionId' },
        ExpressionAttributeValues: { ':inboundAt': inboundAt.toISOString(), ':sessionId': newSessionId() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return res.Attributes as Conversation;
  }

  /**
   * Reclama un mensaje entrante para procesarlo exactamente una vez.
   * - `true`: nadie lo procesó, o un intento anterior quedó en PROCESSING con el lease vencido
   *   (la Lambda falló a mitad de camino): hay que procesarlo.
   * - `false`: ya está DONE o lo está procesando otra invocación ahora mismo: descartar.
   * Siempre terminar con `completeMessage` si salió bien; si falla, no marcar nada y dejar
   * que el reintento lo retome cuando venza el lease.
   */
  async function claimMessage(messageId: string, now = new Date()): Promise<boolean> {
    const nowSec = Math.floor(now.getTime() / 1000);
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tables.inboundMessages,
          Key: { messageId },
          UpdateExpression: 'SET #status = :processing, #leaseUntil = :leaseUntil, #expiresAt = :expiresAt, #updatedAt = :updatedAt',
          ConditionExpression: 'attribute_not_exists(messageId) OR (#status = :processing AND #leaseUntil < :now)',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#leaseUntil': 'leaseUntil',
            '#expiresAt': 'expiresAt',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':processing': 'PROCESSING' satisfies InboundMessage['status'],
            ':leaseUntil': nowSec + MESSAGE_LEASE_SECONDS,
            ':expiresAt': nowSec + MESSAGE_TTL_SECONDS,
            ':updatedAt': now.toISOString(),
            ':now': nowSec,
          },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async function completeMessage(messageId: string, now = new Date()): Promise<void> {
    await doc.send(
      new UpdateCommand({
        TableName: tables.inboundMessages,
        Key: { messageId },
        UpdateExpression: 'SET #status = :done, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':done': 'DONE' satisfies InboundMessage['status'], ':updatedAt': now.toISOString() },
      }),
    );
  }

  return {
    getPackage,
    getPackagesByPhone,
    updatePackageStatus,
    getHopPoint,
    getConversation,
    touchInbound,
    claimMessage,
    completeMessage,
    tables,
  };
}

export type Repos = ReturnType<typeof createRepos>;

/** AgentCore Runtime exige session ids de al menos 33 caracteres; un UUID v4 tiene 36. */
export function newSessionId(): string {
  return randomUUID();
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ConditionalCheckFailedException';
}
