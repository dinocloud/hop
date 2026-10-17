import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { HopStack } from '../../infra/lib/hop-stack.js';

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}

function synth(): Template {
  const app = new cdk.App({
    // Sin bundling de esbuild en los tests de infraestructura.
    context: { 'aws:cdk:bundling-stacks': [] },
  });
  const stack = new HopStack(app, 'HopHackathonDev', {
    env: { account: '123456789012', region: 'us-east-1' },
    stackName: 'hop-hackathon-dev',
    stage: 'dev',
    templateName: 'paquete_listo',
    templateLanguage: 'es_AR',
  });
  return Template.fromStack(stack);
}

function allStatements(template: Template): Statement[] {
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties: { PolicyDocument: { Statement: Statement[] } } }
  >;
  const roles = template.findResources('AWS::IAM::Role') as Record<
    string,
    { Properties: { Policies?: Array<{ PolicyDocument: { Statement: Statement[] } }> } }
  >;
  return [
    ...Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement),
    ...Object.values(roles).flatMap((r) => r.Properties.Policies?.flatMap((p) => p.PolicyDocument.Statement) ?? []),
  ];
}

describe('HopStack', () => {
  const template = synth();

  it('crea las tres tablas con PITR, on-demand y prefijo del proyecto', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
    for (const name of [
      'hop-hackathon-packages',
      'hop-hackathon-hop-points',
      'hop-hackathon-conversations',
      'hop-hackathon-inbound-messages',
    ]) {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    }
  });

  it('la tabla de mensajes entrantes se limpia por TTL', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'hop-hackathon-inbound-messages',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('indexa paquetes por teléfono', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'hop-hackathon-packages',
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'byPhone',
          KeySchema: [
            { AttributeName: 'phone', KeyType: 'HASH' },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' },
          ],
        }),
      ],
    });
  });

  it('despliega dos Lambdas Node 24 arm64 con tracing, concurrencia acotada y retención de logs', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.allResourcesProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      ReservedConcurrentExecutions: 10,
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/hop-hackathon-inbound-router',
      RetentionInDays: 14,
    });
  });

  it('las Lambdas escriben logs solo en su log group, sin políticas administradas', () => {
    const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties: Record<string, unknown> }>;
    for (const role of Object.values(roles)) expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'hop-hackathon-package-status-hook-role',
      Policies: [
        {
          PolicyName: 'logs',
          PolicyDocument: {
            Statement: [
              Match.objectLike({
                Sid: 'WriteOwnLogs',
                Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                Resource: Match.arrayWith([Match.objectLike({ 'Fn::GetAtt': Match.arrayWith(['Arn']) })]),
              }),
            ],
          },
        },
      ],
    });
  });

  it('ningún statement usa Resource "*" salvo el de X-Ray', () => {
    const wildcard = allStatements(template).filter((s) => s.Resource === '*');
    expect(wildcard.length).toBeGreaterThan(0);
    for (const s of wildcard) {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      expect(actions.every((a) => a.startsWith('xray:'))).toBe(true);
    }
  });

  it('acota DynamoDB por acción: el hook actualiza paquetes y el router solo toca conversaciones', () => {
    const hook = allStatements(template).find(
      (s) => Array.isArray(s.Action) && s.Action.includes('dynamodb:UpdateItem') && JSON.stringify(s.Resource).includes('PackagesTable'),
    );
    expect(hook?.Action).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    const router = allStatements(template).find((s) => JSON.stringify(s.Resource).includes('ConversationsTable'));
    expect(router?.Action).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    const dedupe = allStatements(template).find((s) => JSON.stringify(s.Resource).includes('InboundMessagesTable'));
    expect(dedupe?.Action).toEqual('dynamodb:UpdateItem');
    const forbidden = allStatements(template).filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some((a) => ['dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:BatchWriteItem', 'dynamodb:*'].includes(a));
    });
    expect(forbidden).toEqual([]);
  });

  it('lee la configuración de WhatsApp desde SSM y no la hardcodea', () => {
    const params = template.toJSON().Parameters as Record<string, { Type: string; Default?: string }>;
    const ssmParams = Object.values(params).filter(
      (p) => p.Type === 'AWS::SSM::Parameter::Value<String>' && p.Default?.startsWith('/hop-hackathon/'),
    );
    expect(ssmParams.map((p) => p.Default).sort()).toEqual([
      '/hop-hackathon/dev/whatsapp/aws-phone-number-id',
      '/hop-hackathon/dev/whatsapp/inbound-topic-arn',
    ]);
  });

  it('acota el envío de WhatsApp al ARN del número, quitando el prefijo "phone-number-id-" del ID', () => {
    const send = allStatements(template).filter((s) => s.Sid === 'SendWhatsApp');
    expect(send).toHaveLength(2);
    const resource = JSON.stringify(send[0]?.Resource);
    expect(resource).toContain(':phone-number-id/');
    expect(resource).toContain('"Fn::Split":["phone-number-id-"');
    expect(resource).toContain('"Fn::Select":[1');
  });

  it('suscribe el router al topic existente con DLQ, reintentos acotados y alarma', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
      TopicArn: { Ref: Match.stringLikeRegexp('SsmParameterValue.*inboundtopicarn') },
      RedrivePolicy: { deadLetterTargetArn: Match.anyValue() },
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'hop-hackathon-inbound-dlq' });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'hop-hackathon-inbound-dlq-not-empty',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 0,
    });
  });

  it('expone el hook con API key, validación de request y access logs, sin tocar el rol de cuenta', () => {
    template.resourceCountIs('AWS::ApiGateway::Account', 0);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ApiKeyRequired: true,
      RequestValidatorId: Match.anyValue(),
      RequestModels: { 'application/json': Match.anyValue() },
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'dev',
      AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
      MethodSettings: Match.arrayWith([Match.objectLike({ LoggingLevel: 'INFO', ThrottlingRateLimit: 10 })]),
    });
    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', { UsagePlanName: 'hop-hackathon-usage-plan' });
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
  });

  it('gestiona el log group de ejecución de API Gateway con retención', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: { 'Fn::Join': ['', Match.arrayWith(['API-Gateway-Execution-Logs_'])] },
      RetentionInDays: 14,
    });
  });

  it('nombra todos los recursos con nombre físico usando el prefijo del proyecto', () => {
    const names = Object.values(template.toJSON().Resources as Record<string, { Properties?: Record<string, unknown> }>)
      .map((r) => r.Properties?.FunctionName ?? r.Properties?.TableName ?? r.Properties?.QueueName ?? r.Properties?.RoleName)
      .filter((n): n is string => typeof n === 'string');
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) expect(name.startsWith('hop-hackathon-')).toBe(true);
  });
});
