import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { PackageNotFoundError, createRepos, newSessionId } from '../../src/lib/dynamo.js';

const ddb = mockClient(DynamoDBDocumentClient);
const tables = { packages: 'pk', hopPoints: 'hp', conversations: 'cv' };
const NOW = new Date('2026-10-17T12:00:00Z');

function conditionalCheckFailed(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

describe('repos', () => {
  const repos = createRepos({ doc: DynamoDBDocumentClient.from(new DynamoDBClient({})), tables });

  beforeEach(() => ddb.reset());

  it('getPackagesByPhone consulta el GSI byPhone del más reciente al más viejo', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ trackingId: 'HOP-0001' }] });
    const items = await repos.getPackagesByPhone('+5491112345678', 3);
    expect(items).toEqual([{ trackingId: 'HOP-0001' }]);
    const input = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ TableName: 'pk', IndexName: 'byPhone', ScanIndexForward: false, Limit: 3 });
    expect(input?.ExpressionAttributeValues).toEqual({ ':phone': '+5491112345678' });
  });

  it('updatePackageStatus setea estado, punto y plazo, y exige que el paquete exista', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { trackingId: 'HOP-0001', status: 'READY_AT_HOP' } });
    const pkg = await repos.updatePackageStatus(
      'HOP-0001',
      { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineAt: '2026-10-22T12:00:00Z' },
      NOW,
    );
    expect(pkg.status).toBe('READY_AT_HOP');
    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe('attribute_exists(trackingId)');
    expect(input?.UpdateExpression).toBe(
      'SET #status = :status, #updatedAt = :updatedAt, #hopPointId = :hopPointId, #deadlineAt = :deadlineAt REMOVE #scheduledAt',
    );
    expect(input?.ExpressionAttributeValues).toMatchObject({
      ':status': 'READY_AT_HOP',
      ':updatedAt': NOW.toISOString(),
      ':hopPointId': 'hop-palermo',
    });
  });

  it('updatePackageStatus traduce la condición fallida a PackageNotFoundError', async () => {
    ddb.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(repos.updatePackageStatus('NOPE', { status: 'DELIVERED' })).rejects.toThrow(PackageNotFoundError);
  });

  it('touchInbound renueva la ventana, asigna sessionId si falta y deduplica por messageId', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { phone: '+549', lastMessageId: 'wamid.1', sessionId: 'abc' } });
    const first = await repos.touchInbound('+549', 'wamid.1', NOW);
    expect(first).toEqual({ duplicate: false, conversation: { phone: '+549', lastMessageId: 'wamid.1', sessionId: 'abc' } });
    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toContain('if_not_exists(#sessionId, :sessionId)');
    expect(input?.ConditionExpression).toBe('attribute_not_exists(#lastMessageId) OR #lastMessageId <> :messageId');
    expect(input?.ExpressionAttributeValues?.[':now']).toBe(NOW.toISOString());

    ddb.on(UpdateCommand).rejects(conditionalCheckFailed());
    expect(await repos.touchInbound('+549', 'wamid.1', NOW)).toEqual({ duplicate: true });
  });

  it('getHopPoint y getConversation leen por clave', async () => {
    ddb.on(GetCommand, { TableName: 'hp' }).resolves({ Item: { id: 'hop-palermo' } });
    ddb.on(GetCommand, { TableName: 'cv' }).resolves({});
    expect(await repos.getHopPoint('hop-palermo')).toEqual({ id: 'hop-palermo' });
    expect(await repos.getConversation('+549')).toBeUndefined();
  });

  it('los session ids cumplen el mínimo de 33 caracteres de AgentCore', () => {
    expect(newSessionId().length).toBeGreaterThanOrEqual(33);
  });
});
