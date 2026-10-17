import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { ENV, PACKAGE_STATUSES } from '../../src/lib/types.js';

export interface HopStackProps extends cdk.StackProps {
  /** Etapa (hoy solo `dev`). Define el prefijo de parámetros SSM y el stage de la API. */
  readonly stage: string;
  /** Nombre de la plantilla de WhatsApp aprobada en Meta. */
  readonly templateName: string;
}

/** Prefijo de todos los recursos: la cuenta es compartida con otros proyectos. */
export const PREFIX = 'hop-hackathon';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Stack de la aplicación HOP · WhatsApp.
 *
 * Flujo proactivo:  API Gateway → package-status-hook → DynamoDB + End User Messaging Social (template)
 * Flujo de consulta: SNS (End User Messaging Social) → inbound-router → AgentCore → End User Messaging Social
 *
 * Lo que NO crea este stack (lo creó Lean en el setup de WhatsApp y acá solo se lee):
 * - El número de WhatsApp y la WABA en End User Messaging Social.
 * - Los parámetros SSM `/hop-hackathon/<stage>/whatsapp/*`.
 * - El topic SNS de entrantes (acá solo se agrega una suscripción).
 */
export class HopStack extends cdk.Stack {
  readonly packagesTable: dynamodb.Table;
  readonly hopPointsTable: dynamodb.Table;
  readonly conversationsTable: dynamodb.Table;
  readonly packageStatusHookFn: NodejsFunction;
  readonly inboundRouterFn: NodejsFunction;
  readonly api: apigw.RestApi;

  constructor(scope: Construct, id: string, props: HopStackProps) {
    super(scope, id, props);
    const { stage, templateName } = props;

    // ----------------------------------------------------------------------
    // Configuración externa (setup de WhatsApp). Se resuelve en deploy desde SSM.
    // ----------------------------------------------------------------------
    const ssmWhatsApp = `/${PREFIX}/${stage}/whatsapp`;
    const phoneNumberId = ssm.StringParameter.valueForStringParameter(this, `${ssmWhatsApp}/aws-phone-number-id`);
    const inboundTopicArn = ssm.StringParameter.valueForStringParameter(this, `${ssmWhatsApp}/inbound-topic-arn`);
    const phoneNumberArn = cdk.Stack.of(this).formatArn({
      service: 'social-messaging',
      resource: 'phone-number-id',
      resourceName: phoneNumberId,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    // ----------------------------------------------------------------------
    // DynamoDB
    // ----------------------------------------------------------------------
    // RemovalPolicy.DESTROY a propósito: es un hackathon y hay que poder limpiar la
    // cuenta compartida al terminar. En un entorno real sería RETAIN.
    const tableDefaults: Partial<dynamodb.TableProps> = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    };

    this.packagesTable = new dynamodb.Table(this, 'PackagesTable', {
      ...tableDefaults,
      tableName: `${PREFIX}-packages`,
      partitionKey: { name: 'trackingId', type: dynamodb.AttributeType.STRING },
    });
    this.packagesTable.addGlobalSecondaryIndex({
      indexName: 'byPhone',
      partitionKey: { name: 'phone', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    });

    this.hopPointsTable = new dynamodb.Table(this, 'HopPointsTable', {
      ...tableDefaults,
      tableName: `${PREFIX}-hop-points`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
    });

    this.conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      ...tableDefaults,
      tableName: `${PREFIX}-conversations`,
      partitionKey: { name: 'phone', type: dynamodb.AttributeType.STRING },
    });

    // ----------------------------------------------------------------------
    // Lambdas
    // ----------------------------------------------------------------------
    const commonEnv: Record<string, string> = {
      [ENV.STAGE]: stage,
      [ENV.PACKAGES_TABLE]: this.packagesTable.tableName,
      [ENV.HOP_POINTS_TABLE]: this.hopPointsTable.tableName,
      [ENV.CONVERSATIONS_TABLE]: this.conversationsTable.tableName,
      [ENV.PHONE_NUMBER_ID]: phoneNumberId,
      [ENV.TEMPLATE_NAME]: templateName,
      POWERTOOLS_LOG_LEVEL: 'INFO',
      NODE_OPTIONS: '--enable-source-maps',
    };

    const makeFunction = (name: string, entry: string, timeout: cdk.Duration): NodejsFunction => {
      const logGroup = new logs.LogGroup(this, `${name}LogGroup`, {
        logGroupName: `/aws/lambda/${PREFIX}-${name}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const fn = new NodejsFunction(this, `${name}Fn`, {
        functionName: `${PREFIX}-${name}`,
        description: `HOP hackathon - ${name}`,
        entry: path.join(ROOT, 'src', 'lambdas', entry, 'handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout,
        tracing: lambda.Tracing.ACTIVE,
        logGroup,
        environment: { ...commonEnv, POWERTOOLS_SERVICE_NAME: `${PREFIX}-${name}` },
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node24',
          // Se empaqueta el SDK v3 con la versión del lockfile en lugar de usar la del runtime.
          bundleAwsSDK: true,
        },
      });
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason: 'AWSLambdaBasicExecutionRole solo otorga escritura de logs; es el mínimo para una Lambda.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'X-Ray exige recurso * para PutTraceSegments/PutTelemetryRecords.',
            appliesTo: ['Resource::*'],
          },
        ],
        true,
      );
      return fn;
    };

    this.packageStatusHookFn = makeFunction('package-status-hook', 'package-status-hook', cdk.Duration.seconds(30));
    this.inboundRouterFn = makeFunction('inbound-router', 'inbound-router', cdk.Duration.seconds(60));

    // Permisos mínimos por función. Cada PR amplía solo lo que usa.
    this.packagesTable.grantReadWriteData(this.packageStatusHookFn);
    this.hopPointsTable.grantReadData(this.packageStatusHookFn);
    this.conversationsTable.grantReadData(this.packageStatusHookFn);

    this.packagesTable.grantReadData(this.inboundRouterFn);
    this.hopPointsTable.grantReadData(this.inboundRouterFn);
    this.conversationsTable.grantReadWriteData(this.inboundRouterFn);

    for (const fn of [this.packageStatusHookFn, this.inboundRouterFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'SendWhatsApp',
          actions: ['social-messaging:SendWhatsAppMessage'],
          resources: [phoneNumberArn],
        }),
      );
      // grantReadWriteData/grantReadData agregan `table/<name>/index/*` para los GSI.
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Las grants de DynamoDB incluyen los índices de la tabla con el patrón index/*.',
            appliesTo: [
              `Resource::<${this.getLogicalId(this.packagesTable.node.defaultChild as dynamodb.CfnTable)}.Arn>/index/*`,
              `Resource::<${this.getLogicalId(this.hopPointsTable.node.defaultChild as dynamodb.CfnTable)}.Arn>/index/*`,
              `Resource::<${this.getLogicalId(this.conversationsTable.node.defaultChild as dynamodb.CfnTable)}.Arn>/index/*`,
            ],
          },
        ],
        true,
      );
    }

    // ----------------------------------------------------------------------
    // Mensajes entrantes: SNS (End User Messaging Social) → inbound-router
    // ----------------------------------------------------------------------
    const inboundDlq = new sqs.Queue(this, 'InboundDlq', {
      queueName: `${PREFIX}-inbound-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    NagSuppressions.addResourceSuppressions(inboundDlq, [
      { id: 'AwsSolutions-SQS3', reason: 'Esta cola ya es la DLQ; no necesita otra DLQ.' },
    ]);

    const inboundTopic = sns.Topic.fromTopicArn(this, 'InboundTopic', inboundTopicArn);
    inboundTopic.addSubscription(new subs.LambdaSubscription(this.inboundRouterFn, { deadLetterQueue: inboundDlq }));

    // SNS invoca la Lambda de forma asíncrona: reintentos acotados y los fallos van a la DLQ.
    new lambda.EventInvokeConfig(this, 'InboundRouterInvokeConfig', {
      function: this.inboundRouterFn,
      retryAttempts: 2,
      maxEventAge: cdk.Duration.minutes(10),
      onFailure: new destinations.SqsDestination(inboundDlq),
    });

    // ----------------------------------------------------------------------
    // API: hook de estado del paquete
    // ----------------------------------------------------------------------
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/${PREFIX}-api-access`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: `${PREFIX}-api`,
      description: 'HOP hackathon - hook de estado del paquete',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      apiKeySourceType: apigw.ApiKeySourceType.HEADER,
      // La cuenta ya tiene configurado el rol de CloudWatch para API Gateway (es un
      // setting a nivel cuenta, compartido). No lo tocamos.
      cloudWatchRole: false,
      deployOptions: {
        stageName: stage,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
        tracingEnabled: true,
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
        accessLogDestination: new apigw.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    const packageStatusModel = this.api.addModel('PackageStatusModel', {
      modelName: 'PackageStatus',
      contentType: 'application/json',
      schema: {
        schema: apigw.JsonSchemaVersion.DRAFT4,
        title: 'PackageStatus',
        type: apigw.JsonSchemaType.OBJECT,
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: apigw.JsonSchemaType.STRING, enum: [...PACKAGE_STATUSES] },
          hopPointId: { type: apigw.JsonSchemaType.STRING, minLength: 1, maxLength: 64 },
          deadlineDays: { type: apigw.JsonSchemaType.INTEGER, minimum: 1, maximum: 30 },
        },
      },
    });

    const validator = this.api.addRequestValidator('BodyAndParamsValidator', {
      requestValidatorName: 'body-and-params',
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const statusResource = this.api.root.addResource('packages').addResource('{trackingId}').addResource('status');
    statusResource.addMethod('POST', new apigw.LambdaIntegration(this.packageStatusHookFn, { proxy: true }), {
      apiKeyRequired: true,
      requestValidator: validator,
      requestModels: { 'application/json': packageStatusModel },
      requestParameters: { 'method.request.path.trackingId': true },
    });

    const usagePlan = this.api.addUsagePlan('UsagePlan', {
      name: `${PREFIX}-usage-plan`,
      throttle: { rateLimit: 5, burstLimit: 10 },
      quota: { limit: 2000, period: apigw.Period.DAY },
    });
    const hookApiKey = this.api.addApiKey('HookApiKey', {
      apiKeyName: `${PREFIX}-hook-key`,
      description: 'Clave para el sistema de envíos que notifica el estado del paquete',
    });
    usagePlan.addApiKey(hookApiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    NagSuppressions.addResourceSuppressions(
      this.api,
      [
        {
          id: 'AwsSolutions-APIG4',
          reason: 'Integración máquina a máquina protegida con API key + usage plan. Sin usuarios finales; alcance hackathon.',
        },
        {
          id: 'AwsSolutions-COG4',
          reason: 'No hay usuarios finales: el caller es el sistema de envíos, autenticado con API key.',
        },
        {
          id: 'AwsSolutions-APIG3',
          reason: 'Sin WAF en el hackathon: el endpoint exige API key y tiene throttling y cuota diaria.',
        },
      ],
      true,
    );

    // ----------------------------------------------------------------------
    // Outputs
    // ----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url, description: 'Base URL del hook' });
    new cdk.CfnOutput(this, 'HookApiKeyId', {
      value: hookApiKey.keyId,
      description: 'Valor: aws apigateway get-api-key --api-key <id> --include-value',
    });
    new cdk.CfnOutput(this, 'PackagesTableName', { value: this.packagesTable.tableName });
    new cdk.CfnOutput(this, 'HopPointsTableName', { value: this.hopPointsTable.tableName });
    new cdk.CfnOutput(this, 'ConversationsTableName', { value: this.conversationsTable.tableName });
    new cdk.CfnOutput(this, 'InboundDlqUrl', { value: inboundDlq.queueUrl });
  }
}
