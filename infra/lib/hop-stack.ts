import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
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
  /** Perfil de inferencia de Bedrock que usa el agente (ej. `us.anthropic.claude-sonnet-5-5`). */
  readonly agentModelId: string;
  /** Carpeta con el bundle del agente (`npm run build:agent`). Default: `agent/dist`. */
  readonly agentCodePath?: string;
  /** Entry point del código del agente dentro del zip. Default: `['index.js']`. */
  readonly agentEntryPoint?: string[];
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
  readonly agentRuntime: agentcore.CfnRuntime;

  constructor(scope: Construct, id: string, props: HopStackProps) {
    super(scope, id, props);
    const { stage, templateName, templateLanguage, agentModelId } = props;

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
    // UpdateItem condicional para el claim; GetItem para distinguir DONE de "en proceso" cuando el claim falla.
    this.inboundMessagesTable.grant(this.inboundRouterFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');

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
    // Agente en AgentCore Runtime (deploy de código directo, Node 22, sin contenedor)
    // ----------------------------------------------------------------------
    // El bundle (`npm run build:agent`) se sube como asset a S3 y el runtime lo carga desde ahí.
    // Cada cambio de código cambia la clave del asset y genera una versión nueva del runtime.
    const agentCode = new s3_assets.Asset(this, 'AgentCode', {
      path: props.agentCodePath ?? path.join(ROOT, 'agent', 'dist'),
    });

    const agentRole = new iam.Role(this, 'AgentRuntimeRole', {
      roleName: `${PREFIX}-agent-runtime-role`,
      description: 'Rol de ejecución del agente HOP en AgentCore Runtime',
      // Trust acotado a los runtimes de ESTA cuenta y región (anti confused deputy).
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
    });
    // Solo el zip del agente, no todo el bucket de assets de CDK (que comparten otros proyectos).
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadAgentCode',
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [agentCode.bucket.arnForObjects(agentCode.s3ObjectKey)],
      }),
    );
    const agentRuntimeName = `${PREFIX.replace(/-/g, '_')}_agent`;
    const inferenceProfileArn = `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${agentModelId}`;
    // Tools de consulta: solo lectura de paquetes (por tracking y por teléfono vía GSI) y Puntos HOP.
    this.packagesTable.grant(agentRole, 'dynamodb:GetItem', 'dynamodb:Query');
    this.hopPointsTable.grant(agentRole, 'dynamodb:GetItem');
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeClaude',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [inferenceProfileArn],
      }),
    );
    // El perfil `us.` enruta a los foundation models de Claude en las regiones de EE. UU.; se
    // permiten solo cuando la llamada viene a través de ESTE perfil de inferencia.
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeClaudeViaProfile',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['arn:aws:bedrock:*::foundation-model/anthropic.claude-*'],
        conditions: { StringEquals: { 'bedrock:InferenceProfileArn': inferenceProfileArn } },
      }),
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
      }),
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeDescribeLogGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
      }),
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeTraces',
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
        resources: ['*'],
      }),
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WorkloadIdentity',
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${agentRuntimeName}-*`,
        ],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      agentRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Permisos estándar del rol de ejecución de AgentCore Runtime: log groups del servicio, workload identity del runtime, X-Ray y métricas (acotadas por namespace), lectura del asset de código y modelos Claude del perfil de inferencia.',
          appliesTo: [
            'Resource::*',
            'Resource::arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
            `Resource::arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
            `Resource::arn:aws:logs:${this.region}:${this.account}:log-group:*`,
            `Resource::arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${agentRuntimeName}-*`,
            `Resource::<${this.getLogicalId(this.packagesTable.node.defaultChild as dynamodb.CfnTable)}.Arn>/index/*`,
          ],
        },
      ],
      true,
    );

    this.agentRuntime = new agentcore.CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName,
      description: 'HOP hackathon - agente de seguimiento de paquetes (Strands, TypeScript)',
      roleArn: agentRole.roleArn,
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: agentCode.s3BucketName, prefix: agentCode.s3ObjectKey } },
          runtime: 'NODE_22',
          entryPoint: props.agentEntryPoint ?? ['index.js'],
        },
      },
      // PUBLIC: solo para dev. En un entorno real iría en VPC. Sin authorizer: el único caller
      // es la Lambda inbound, autenticada por SigV4 e IAM.
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables: {
        [ENV.STAGE]: stage,
        [ENV.PACKAGES_TABLE]: this.packagesTable.tableName,
        [ENV.HOP_POINTS_TABLE]: this.hopPointsTable.tableName,
        [ENV.CONVERSATIONS_TABLE]: this.conversationsTable.tableName,
        [ENV.INBOUND_MESSAGES_TABLE]: this.inboundMessagesTable.tableName,
        MODEL_ID: agentModelId,
      },
    });
    this.agentRuntime.node.addDependency(agentRole);

    // AgentCore crea el log group del endpoint DEFAULT sin retención. Se declara acá para que
    // tenga retención y se borre con el stack. Si el nombre no coincidiera con el que usa el
    // servicio, queda un log group vacío sin otro efecto.
    new logs.LogGroup(this, 'AgentRuntimeLogs', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${this.agentRuntime.attrAgentRuntimeId}-DEFAULT`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // La Lambda inbound invoca el runtime (endpoint DEFAULT).
    this.inboundRouterFn.addEnvironment(ENV.AGENT_RUNTIME_ARN, this.agentRuntime.attrAgentRuntimeArn);
    this.inboundRouterFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeAgent',
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [this.agentRuntime.attrAgentRuntimeArn, `${this.agentRuntime.attrAgentRuntimeArn}/runtime-endpoint/*`],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      this.inboundRouterFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'InvokeAgentRuntime exige el ARN del runtime y el de sus endpoints (runtime-endpoint/*).',
          appliesTo: [`Resource::<${this.getLogicalId(this.agentRuntime)}.AgentRuntimeArn>/runtime-endpoint/*`],
        },
      ],
      true,
    );

    new ssm.StringParameter(this, 'AgentRuntimeArnParam', {
      parameterName: `/${PREFIX}/${stage}/app/agent-runtime-arn`,
      stringValue: this.agentRuntime.attrAgentRuntimeArn,
      description: 'ARN del runtime de AgentCore del agente HOP (lo crea el stack)',
    });

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
    // Caminos en los que un cliente se queda sin respuesta (o sin respuesta útil): alarma visible.
    for (const [id, metricName, description] of [
      ['InboundParseErrorAlarm', 'InboundParseError', 'Eventos de WhatsApp con formato desconocido: se están descartando mensajes'],
      ['ReplyFailedAlarm', 'ReplyFailed', 'No se pudo enviar la respuesta a un cliente por WhatsApp'],
      ['ReplyDeliveryFailedAlarm', 'ReplyDeliveryFailed', 'Meta no pudo entregar una respuesta (status failed)'],
      ['AgentFailedAlarm', 'AgentFailed', 'El agente de AgentCore falló y se respondió con la disculpa genérica'],
    ] as const) {
      new cloudwatch.Alarm(this, id, {
        alarmName: `${PREFIX}-${metricName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
        alarmDescription: description,
        metric: new cloudwatch.Metric({
          namespace: METRICS_NAMESPACE,
          metricName,
          dimensionsMap: { service: 'inbound-router' },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

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
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: this.agentRuntime.attrAgentRuntimeArn,
      description: 'aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn <arn> ...',
    });
  }
}
