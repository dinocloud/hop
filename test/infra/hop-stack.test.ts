import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { HopStack } from '../../infra/lib/hop-stack.js';

function synth(): Template {
  const app = new cdk.App({
    // Sin bundling de esbuild en los tests de infraestructura.
    context: { 'aws:cdk:bundling-stacks': [] },
  });
  const stack = new HopStack(app, 'HopHackathonDev', {
    env: { account: '123456789012', region: 'us-east-1' },
    stage: 'dev',
    templateName: 'paquete_listo',
  });
  return Template.fromStack(stack);
}

describe('HopStack', () => {
  const template = synth();

  it('crea las tres tablas con PITR, on-demand y prefijo del proyecto', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
    for (const name of ['hop-hackathon-packages', 'hop-hackathon-hop-points', 'hop-hackathon-conversations']) {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    }
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

  it('despliega dos Lambdas Node 24 arm64 con tracing y retención de logs', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.allResourcesProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/hop-hackathon-inbound-router',
      RetentionInDays: 14,
    });
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

  it('acota el envío de WhatsApp al número del proyecto', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'SendWhatsApp',
            Action: 'social-messaging:SendWhatsAppMessage',
            Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
          }),
        ]),
      },
    });
  });

  it('suscribe el router al topic existente con DLQ y reintentos acotados', () => {
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

  it('etiqueta y nombra con el prefijo del proyecto', () => {
    const names = Object.values(template.toJSON().Resources as Record<string, { Properties?: Record<string, unknown> }>)
      .map((r) => r.Properties?.FunctionName ?? r.Properties?.TableName ?? r.Properties?.QueueName)
      .filter((n): n is string => typeof n === 'string');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.startsWith('hop-hackathon-')).toBe(true);
  });
});
