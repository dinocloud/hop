import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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
  /** Código de idioma con el que se aprobó la plantilla (ej. `es_AR`). */
  readonly templateLanguage: string;
}

/** Prefijo de todos los recursos: la cuenta es compartida con otros proyectos. */
export const PREFIX = 'hop-hackathon';

/** Tope de concurrencia por Lambda: acota el impacto sobre el pool compartido de la cuenta. */
const RESERVED_CONCURRENCY = 10;

/** Namespace de las métricas custom (Powertools Metrics, EMF). */
export const METRICS_NAMESPACE = 'HopHackathon';

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
  readonly inboundMessagesTable: dynamodb.Table;
  readonly packageStatusHookFn: NodejsFunction;
  readonly inboundRouterFn: NodejsFunction;
  readonly api: apigw.RestApi;

  constructor(scope: Construct, id: string, props: HopStackProps) {
    super(scope, id, props);
    const { stage, templateName, templateLanguage } = props;

    // ----------------------------------------------------------------------
    // Configuración externa (setup de WhatsApp). Se resuelve en deploy desde SSM.
    // ----------------------------------------------------------------------
    const ssmWhatsApp = `/${PREFIX}/${stage}/whatsapp`;
    // ID de AWS del número: `phone-number-id-<hex>`. Es el `originationPhoneNumberId` de la API.
    const originationPhoneNumberId = ssm.StringParameter.valueForStringParameter(
      this,
      `${ssmWhatsApp}/aws-phone-number-id`,
    );
    const inboundTopicArn = ssm.StringParameter.valueForStringParameter(this, `${ssmWhatsApp}/inbound-topic-arn`);

    // El ARN del número NO repite el prefijo del ID:
    //   id : phone-number-id-3967ed...
    //   arn: arn:aws:social-messaging:us-east-1:<cuenta>:phone-number-id/3967ed...
    const phoneNumberArn = cdk.Stack.of(this).formatArn({
      service: 'social-messaging',
      resource: 'phone-number-id',
      resourceName: cdk.Fn.select(1, cdk.Fn.split('phone-number-id-', originationPhoneNumberId)),
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

    // Un ítem por mensaje entrante: procesar cada uno exactamente una vez aunque SNS/Lambda
    // reintenten. Se limpia solo por TTL.
    this.inboundMessagesTable = new dynamodb.Table(this, 'InboundMessagesTable', {
      ...tableDefaults,
      tableName: `${PREFIX}-inbound-messages`,
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });

    // ----------------------------------------------------------------------
    // Lambdas
    // ----------------------------------------------------------------------
    const commonEnv: Record<string, string> = {
      [ENV.STAGE]: stage,
      [ENV.PACKAGES_TABLE]: this.packagesTable.tableName,
      [ENV.HOP_POINTS_TABLE]: this.hopPointsTable.tableName,
      [ENV.CONVERSATIONS_TABLE]: this.conversationsTable.tableName,
      [ENV.INBOUND_MESSAGES_TABLE]: this.inboundMessagesTable.tableName,
      [ENV.ORIGINATION_PHONE_NUMBER_ID]: originationPhoneNumberId,
      [ENV.TEMPLATE_NAME]: templateName,
      [ENV.TEMPLATE_LANGUAGE]: templateLanguage,
      POWERTOOLS_LOG_LEVEL: 'INFO',
      POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const makeFunction = (name: string, entry: string, timeout: cdk.Duration): NodejsFunction => {
      const logGroup = new logs.LogGroup(this, `${name}LogGroup`, {
        logGroupName: `/aws/lambda/${PREFIX}-${name}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      // Rol propio en lugar de AWSLambdaBasicExecutionRole: escritura de logs acotada a SU log group.
      const role = new iam.Role(this, `${name}Role`, {
        roleName: `${PREFIX}-${name}-role`,
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          logs: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: 'WriteOwnLogs',
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
              }),
            ],
          }),
        },
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
        role,
        reservedConcurrentExecutions: RESERVED_CONCURRENCY,
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
      // X-Ray exige recurso * para PutTraceSegments/PutTelemetryRecords. La supresión se limita a
      // ese caso; un test del stack verifica que ningún otro statement use Resource "*".
      NagSuppressions.addResourceSuppressions(
        role,
        [
          { id: 'AwsSolutions-IAM5', reason: 'X-Ray exige recurso * para PutTraceSegments/PutTelemetryRecords.', appliesTo: ['Resource::*'] },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Los log streams viven bajo el propio log group de la función (<arn>:*); no es un comodín sobre otros log groups.',
            appliesTo: [`Resource::<${this.getLogicalId(logGroup.node.defaultChild as logs.CfnLogGroup)}.Arn>:*`],
          },
        ],
        true,
      );
      return fn;
    };

    // 20 s: siempre por debajo del timeout de integración de API Gateway (29 s), así el caller
    // recibe la respuesta de la Lambda y no un 504 mientras la Lambda sigue corriendo.
    this.packageStatusHookFn = makeFunction('package-status-hook', 'package-status-hook', cdk.Duration.seconds(20));
    this.inboundRouterFn = makeFunction('inbound-router', 'inbound-router', cdk.Duration.seconds(60));

    // Permisos mínimos por función y por acción. Cada PR amplía solo lo que usa.
    // Hook: lee y actualiza paquetes, lee el Punto HOP para el nombre de la plantilla.
    this.packagesTable.grant(this.packageStatusHookFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    this.hopPointsTable.grant(this.packageStatusHookFn, 'dynamodb:GetItem');
    // Router: la conversación (ventana de 24 h, sessionId) y el dedupe por mensaje. Los paquetes los lee el agente.
    this.conversationsTable.grant(this.inboundRouterFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    this.inboundMessagesTable.grant(this.inboundRouterFn, 'dynamodb:UpdateItem');

    for (const fn of [this.packageStatusHookFn, this.inboundRouterFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'SendWhatsApp',
          actions: ['social-messaging:SendWhatsAppMessage'],
          resources: [phoneNumberArn],
        }),
      );
    }
    // `grant` sobre una tabla con GSI incluye `table/<name>/index/*`.
    NagSuppressions.addResourceSuppressions(
      this.packageStatusHookFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'La grant de DynamoDB incluye los índices de la tabla Packages con el patrón index/*.',
          appliesTo: [`Resource::<${this.getLogicalId(this.packagesTable.node.defaultChild as dynamodb.CfnTable)}.Arn>/index/*`],
        },
      ],
      true,
    );

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
    // La DLQ recibe dos formatos: el mensaje crudo de SNS (fallo de entrega) y el envelope de
    // Lambda Destinations (fallo de ejecución). Un redrive tiene que contemplar ambos.
    new lambda.EventInvokeConfig(this, 'InboundRouterInvokeConfig', {
      function: this.inboundRouterFn,
      retryAttempts: 2,
      maxEventAge: cdk.Duration.minutes(10),
      onFailure: new destinations.SqsDestination(inboundDlq),
    });

    // Un mensaje de un cliente en la DLQ es una conversación sin respuesta: alarma visible en
    // CloudWatch. El ticket de observabilidad le suma la acción de notificación.
    new cloudwatch.Alarm(this, 'InboundDlqAlarm', {
      alarmName: `${PREFIX}-inbound-dlq-not-empty`,
      alarmDescription: 'Hay mensajes de WhatsApp sin procesar en la DLQ de hop-hackathon',
      metric: inboundDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Un aviso "paquete listo" que no sale es un cliente sin notificación: alarma visible.
    new cloudwatch.Alarm(this, 'TemplateSendFailedAlarm', {
      alarmName: `${PREFIX}-template-send-failed`,
      alarmDescription: 'Falló el envío de la plantilla "paquete listo" (ver logs de package-status-hook)',
      metric: new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName: 'TemplateSendFailed',
        dimensionsMap: { service: 'package-status-hook' },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
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
      // setting a nivel cuenta, compartido). No lo tocamos. cdk.json además lo desactiva por defecto.
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

    // Con loggingLevel INFO el servicio crea solo este log group, sin retención y fuera del
    // stack. Se declara acá para que tenga retención y se borre con el stack.
    const apiExecutionLogs = new logs.LogGroup(this, 'ApiExecutionLogs', {
      logGroupName: `API-Gateway-Execution-Logs_${this.api.restApiId}/${stage}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.api.deploymentStage.node.addDependency(apiExecutionLogs);

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

    // La validación de API Gateway aplica solo a `application/json`; la Lambda vuelve a validar
    // el body con zod, así que un Content-Type distinto no se saltea nada.
    const statusResource = this.api.root.addResource('packages').addResource('{trackingId}').addResource('status');
    const statusMethod = statusResource.addMethod('POST', new apigw.LambdaIntegration(this.packageStatusHookFn, { proxy: true }), {
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

    // Supresiones acotadas al método y al stage: un método nuevo sin API key sí dispara cdk-nag.
    NagSuppressions.addResourceSuppressions(statusMethod, [
      {
        id: 'AwsSolutions-APIG4',
        reason: 'Integración máquina a máquina protegida con API key + usage plan. Sin usuarios finales; alcance hackathon.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'No hay usuarios finales: el caller es el sistema de envíos, autenticado con API key.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(this.api.deploymentStage, [
      {
        id: 'AwsSolutions-APIG3',
        reason: 'Sin WAF en el hackathon: el endpoint exige API key y tiene throttling y cuota diaria.',
      },
    ]);

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
    new cdk.CfnOutput(this, 'InboundMessagesTableName', { value: this.inboundMessagesTable.tableName });
    new cdk.CfnOutput(this, 'InboundDlqUrl', { value: inboundDlq.queueUrl });
  }
}
