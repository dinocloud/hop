import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { Conversation, HopPoint, Package, PackageStatus } from './types.js';
import { requireEnv } from './types.js';

export interface TableNames {
  packages: string;
  hopPoints: string;
  conversations: string;
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

export interface TouchInboundResult {
  /** `true` si ese `messageId` ya había sido procesado (reintento de SNS/Lambda). */
  duplicate: boolean;
  conversation?: Conversation;
}

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
  };
}

export function createDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * Acceso tipado a las tres tablas. Cada Lambda crea una instancia fuera del handler
 * (reutiliza la conexión entre invocaciones) e inyecta mocks en los tests.
 */
export function createRepos(deps: ReposDeps = {}) {
  const doc = deps.doc ?? createDocumentClient();
  const tables = deps.tables ?? tableNamesFromEnv();

  async function getPackage(trackingId: string): Promise<Package | undefined> {
    const res = await doc.send(new GetCommand({ TableName: tables.packages, Key: { trackingId } }));
    return res.Item as Package | undefined;
  }

  /** Paquetes de un teléfono, el más reciente primero. */
  async function getPackagesByPhone(phone: string, limit = 5): Promise<Package[]> {
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
      names[`#${field}`] = field;
      if (value !== undefined) {
        sets.push(`#${field} = :${field}`);
        values[`:${field}`] = value;
      } else if (field !== 'hopPointId') {
        // Un cambio de estado invalida plazos y reprogramaciones anteriores.
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

  async function getConversation(phone: string): Promise<Conversation | undefined> {
    const res = await doc.send(new GetCommand({ TableName: tables.conversations, Key: { phone } }));
    return res.Item as Conversation | undefined;
  }

  /**
   * Registra un mensaje entrante: abre/renueva la ventana de 24 h, asigna `sessionId`
   * si no existía y deduplica por `messageId` (reintentos de SNS → Lambda).
   */
  async function touchInbound(phone: string, messageId: string, now = new Date()): Promise<TouchInboundResult> {
    try {
      const res = await doc.send(
        new UpdateCommand({
          TableName: tables.conversations,
          Key: { phone },
          UpdateExpression:
            'SET #lastInboundAt = :now, #lastMessageId = :messageId, #sessionId = if_not_exists(#sessionId, :sessionId)',
          ConditionExpression: 'attribute_not_exists(#lastMessageId) OR #lastMessageId <> :messageId',
          ExpressionAttributeNames: {
            '#lastInboundAt': 'lastInboundAt',
            '#lastMessageId': 'lastMessageId',
            '#sessionId': 'sessionId',
          },
          ExpressionAttributeValues: {
            ':now': now.toISOString(),
            ':messageId': messageId,
            ':sessionId': newSessionId(),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { duplicate: false, conversation: res.Attributes as Conversation };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { duplicate: true };
      throw err;
    }
  }

  return { getPackage, getPackagesByPhone, updatePackageStatus, getHopPoint, getConversation, touchInbound, tables };
}

export type Repos = ReturnType<typeof createRepos>;

/** AgentCore Runtime exige session ids de al menos 33 caracteres; un UUID v4 tiene 36. */
export function newSessionId(): string {
  return randomUUID();
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ConditionalCheckFailedException';
}
