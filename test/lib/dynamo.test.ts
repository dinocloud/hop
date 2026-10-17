import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConcurrentUpdateError,
  MESSAGE_LEASE_SECONDS,
  PackageNotFoundError,
  createRepos,
  newSessionId,
} from '../../src/lib/dynamo.js';
import { InvalidPhoneError } from '../../src/lib/phone.js';

const ddb = mockClient(DynamoDBDocumentClient);
const tables = { packages: 'pk', hopPoints: 'hp', conversations: 'cv', inboundMessages: 'im' };
const NOW = new Date('2026-10-17T12:00:00Z');
const PHONE = '+5491112345678';

function conditionalCheckFailed(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

/** Invariante de DynamoDB: todo nombre/valor declarado tiene que aparecer en alguna expresión. */
function expectExpressionsConsistent(input: {
  UpdateExpression?: string;
  ConditionExpression?: string;
  KeyConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}) {
  const expressions = [input.UpdateExpression, input.ConditionExpression, input.KeyConditionExpression].filter(Boolean).join(' ');
  for (const name of Object.keys(input.ExpressionAttributeNames ?? {})) {
    expect(expressions, `nombre ${name} sin usar`).toMatch(new RegExp(`${name}(?![A-Za-z0-9_])`));
  }
  for (const value of Object.keys(input.ExpressionAttributeValues ?? {})) {
    expect(expressions, `valor ${value} sin usar`).toMatch(new RegExp(`${value}(?![A-Za-z0-9_])`));
  }
}

describe('repos', () => {
  const repos = createRepos({ doc: DynamoDBDocumentClient.from(new DynamoDBClient({})), tables });

  beforeEach(() => ddb.reset());

  it('getPackagesByPhone normaliza el teléfono y consulta el GSI byPhone del más reciente al más viejo', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ trackingId: 'HOP-0001' }] });
    const items = await repos.getPackagesByPhone('+54 9 11 1234-5678', 3);
    expect(items).toEqual([{ trackingId: 'HOP-0001' }]);
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ TableName: 'pk', IndexName: 'byPhone', ScanIndexForward: false, Limit: 3 });
    expect(input.ExpressionAttributeValues).toEqual({ ':phone': PHONE });
    expectExpressionsConsistent(input);
    await expect(repos.getPackagesByPhone('5491112345678')).rejects.toThrow(InvalidPhoneError);
  });

  it('updatePackageStatus setea estado, punto y plazo, y exige que el paquete exista', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { trackingId: 'HOP-0001', status: 'READY_AT_HOP' } });
    const pkg = await repos.updatePackageStatus(
      'HOP-0001',
      { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineAt: '2026-10-22T12:00:00Z' },
      NOW,
    );
    expect(pkg.status).toBe('READY_AT_HOP');
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('attribute_exists(trackingId)');
    expect(input.UpdateExpression).toBe(
      'SET #status = :status, #updatedAt = :updatedAt, #hopPointId = :hopPointId, #deadlineAt = :deadlineAt REMOVE #scheduledAt',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':status': 'READY_AT_HOP',
      ':updatedAt': NOW.toISOString(),
      ':hopPointId': 'hop-palermo',
    });
    expectExpressionsConsistent(input);
  });

  it('updatePackageStatus con solo el estado no declara nombres sin usar (DynamoDB lo rechazaría)', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { trackingId: 'HOP-0001', status: 'DELIVERED' } });
    await repos.updatePackageStatus('HOP-0001', { status: 'DELIVERED' }, NOW);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toBe('SET #status = :status, #updatedAt = :updatedAt REMOVE #deadlineAt, #scheduledAt');
    expect(Object.keys(input.ExpressionAttributeNames ?? {})).not.toContain('#hopPointId');
    expectExpressionsConsistent(input);
  });

  it('updatePackageStatus traduce la condición fallida a PackageNotFoundError', async () => {
    ddb.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(repos.updatePackageStatus('NOPE', { status: 'DELIVERED' })).rejects.toThrow(PackageNotFoundError);
  });

  it('updatePackageStatus con expectedUpdatedAt exige la versión leída y limpia el aviso si se pide', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { trackingId: 'HOP-0001', status: 'DELIVERED' } });
    await repos.updatePackageStatus('HOP-0001', { status: 'DELIVERED', resetReadyNotification: true }, NOW, {
      expectedUpdatedAt: '2026-10-17T10:00:00Z',
    });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('attribute_exists(trackingId) AND #updatedAt = :expectedUpdatedAt');
    expect(input.ExpressionAttributeValues?.[':expectedUpdatedAt']).toBe('2026-10-17T10:00:00Z');
    expect(input.UpdateExpression).toContain('REMOVE #deadlineAt, #scheduledAt, #readyNotificationStatus, #readyNotifiedAt, #readyMessageId, #readyNotificationError');
    expectExpressionsConsistent(input);

    ddb.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(
      repos.updatePackageStatus('HOP-0001', { status: 'DELIVERED' }, NOW, { expectedUpdatedAt: 'x' }),
    ).rejects.toThrow(ConcurrentUpdateError);
  });

  it('markReadyNotification registra SENT con messageId y FAILED con el nombre del error', async () => {
    ddb.on(UpdateCommand).resolves({});
    await repos.markReadyNotification('HOP-0001', { status: 'SENT', messageId: 'wamid.1' }, NOW);
    await repos.markReadyNotification('HOP-0001', { status: 'FAILED', error: 'ValidationException' }, NOW);
    const [sent, failed] = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(sent!.UpdateExpression).toBe(
      'SET #readyNotificationStatus = :status, #readyNotifiedAt = :at, #readyMessageId = :messageId REMOVE #readyNotificationError',
    );
    expect(failed!.UpdateExpression).toBe(
      'SET #readyNotificationStatus = :status, #readyNotifiedAt = :at, #readyNotificationError = :error REMOVE #readyMessageId',
    );
    expectExpressionsConsistent(sent!);
    expectExpressionsConsistent(failed!);
  });

  it('touchInbound renueva la ventana con la fecha del mensaje y asigna sessionId si falta', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { phone: PHONE, lastInboundAt: NOW.toISOString(), sessionId: 'abc' } });
    const conversation = await repos.touchInbound('+54 9 11 1234-5678', NOW);
    expect(conversation.sessionId).toBe('abc');
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ phone: PHONE });
    expect(input.UpdateExpression).toContain('if_not_exists(#sessionId, :sessionId)');
    expect(input.ExpressionAttributeValues?.[':inboundAt']).toBe(NOW.toISOString());
    expectExpressionsConsistent(input);
  });

  it('claimMessage procesa cada mensaje una sola vez y retoma los leases vencidos', async () => {
    ddb.on(UpdateCommand).resolves({});
    expect(await repos.claimMessage('wamid.A', NOW)).toBe(true);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.TableName).toBe('im');
    expect(input.ConditionExpression).toBe('attribute_not_exists(messageId) OR (#status = :processing AND #leaseUntil < :now)');
    const nowSec = Math.floor(NOW.getTime() / 1000);
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':processing': 'PROCESSING',
      ':leaseUntil': nowSec + MESSAGE_LEASE_SECONDS,
      ':now': nowSec,
    });
    expectExpressionsConsistent(input);

    // Reintento mientras otro intento sigue en PROCESSING o ya está DONE: condición fallida → descartar.
    ddb.on(UpdateCommand).rejects(conditionalCheckFailed());
    expect(await repos.claimMessage('wamid.A', NOW)).toBe(false);
  });

  it('completeMessage marca DONE', async () => {
    ddb.on(UpdateCommand).resolves({});
    await repos.completeMessage('wamid.A', NOW);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues?.[':done']).toBe('DONE');
    expectExpressionsConsistent(input);
  });

  it('getConversation normaliza el teléfono y lee con consistencia fuerte', async () => {
    ddb.on(GetCommand, { TableName: 'hp' }).resolves({ Item: { id: 'hop-palermo' } });
    ddb.on(GetCommand, { TableName: 'cv' }).resolves({});
    expect(await repos.getHopPoint('hop-palermo')).toEqual({ id: 'hop-palermo' });
    expect(await repos.getConversation('+54 9 11 1234-5678')).toBeUndefined();
    const input = ddb.commandCalls(GetCommand)[1]!.args[0].input;
    expect(input).toMatchObject({ TableName: 'cv', Key: { phone: PHONE }, ConsistentRead: true });
  });

  it('los session ids cumplen el mínimo de 33 caracteres de AgentCore', () => {
    expect(newSessionId().length).toBeGreaterThanOrEqual(33);
  });
});
