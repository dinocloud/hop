# HOP · WhatsApp

Bot de WhatsApp para los Puntos HOP sobre **AWS End User Messaging Social** y **Amazon Bedrock AgentCore**.

- **Aviso proactivo**: cuando el paquete llega al Punto HOP, un sistema externo pega a un hook y la persona recibe una plantilla de WhatsApp ("tu paquete está listo, tenés X días").
- **Consulta**: la persona escribe "¿dónde está mi paquete?" y un agente responde estado, horarios y la ubicación del punto como mensaje de ubicación.

Tablero de tareas: lista "Hop Team - Hackthon" en ClickUp.

## Arquitectura

```
Sistema de envíos ──POST /packages/{trackingId}/status (API key)──► API Gateway ──► Lambda package-status-hook ──► DynamoDB Packages
                                                                                                        └──► End User Messaging Social (template) ──► WhatsApp

WhatsApp ──► End User Messaging Social ──► SNS hop-hackathon-whatsapp-inbound ──► Lambda inbound-router ──► AgentCore Runtime (agente Strands, TypeScript)
                                                                                         │                          └──► DynamoDB Packages / HopPoints (tools)
                                                                                         ├──► DynamoDB Conversations (ventana 24 h, sessionId, dedupe)
                                                                                         └──► End User Messaging Social (texto + ubicación)
```

Todo vive en un stack CDK, `HopHackathonDev` (nombre físico en CloudFormation: `hop-hackathon-dev`), en la cuenta `dino-dev` (`359328299440`, `us-east-1`). La cuenta es **compartida con otros proyectos**: todos los recursos llevan el prefijo `hop-hackathon-` y las tags `Project=hop-hackathon`, `Environment=dev`, `ManagedBy=cdk`.

### Lo que el stack NO crea

Lo armó Lean en el setup de WhatsApp y acá solo se lee:

| Recurso | Dónde |
|---|---|
| Número de WhatsApp y WABA | AWS End User Messaging Social |
| IDs del número y la WABA | SSM `/hop-hackathon/dev/whatsapp/*` (`aws-phone-number-id`, `phone-number-id`, `waba-id`, `display-phone-number`) |
| Topic de mensajes entrantes | SNS `hop-hackathon-whatsapp-inbound` (SSM `.../inbound-topic-arn`). El stack solo agrega su suscripción. |

El stack usa `aws-phone-number-id` (el ID de AWS, `phone-number-id-...`) como origen de los envíos. El `phone-number-id` numérico es el de Meta y no se usa en la API de AWS.

### Modelo de datos (DynamoDB)

| Tabla | Clave | Atributos |
|---|---|---|
| `hop-hackathon-packages` | PK `trackingId`; GSI `byPhone` (PK `phone`, SK `updatedAt`) | `customerName`, `status` (`IN_TRANSIT` · `READY_AT_HOP` · `DELIVERED` · `RETURNED`), `hopPointId`, `deadlineAt`, `scheduledAt`, `updatedAt` |
| `hop-hackathon-hop-points` | PK `id` | `name`, `address`, `lat`, `lng`, `openingHours` |
| `hop-hackathon-conversations` | PK `phone` | `lastInboundAt`, `sessionId`, `lastTrackingId` |
| `hop-hackathon-inbound-messages` | PK `messageId`; TTL `expiresAt` | `status` (`PROCESSING` · `DONE`), `leaseUntil`, `updatedAt`. Un ítem por mensaje de WhatsApp para procesarlo exactamente una vez |

Los tipos están en `src/lib/types.ts`. Los teléfonos van siempre en E.164 **con `+`** (`+5491112345678`): End User Messaging Social lo exige al enviar.

## Estructura del repo

```
.github/workflows/   ci.yml (validación en todas las ramas) · deploy.yml (deploy al mergear a main)
infra/bin/hop.ts     app CDK: HopHackathonCi + HopHackathonDev
infra/lib/           ci-stack.ts (rol OIDC para GitHub Actions) · hop-stack.ts (la aplicación)
src/lib/             tipos, logger, clientes compartidos
src/lambdas/         package-status-hook · inbound-router
agent/               agente para AgentCore Runtime (se agrega en su PR)
scripts/             seed.ts y utilidades de verificación
test/                vitest: infra (assertions) + unit
```

## Requisitos

- Node 22+ y npm.
- AWS CLI v2 con el perfil SSO `dino-dev` (solo para seed y verificación manual; el deploy lo hace el pipeline).

```bash
npm ci
npm run typecheck   # tsc
npm test            # vitest
npm run synth       # cdk synth --strict con cdk-nag (sin credenciales)
```

## CI/CD

### Validación (todas las ramas y PRs)

`ci.yml` corre typecheck, tests y `cdk synth` con **cdk-nag** (`AwsSolutionsChecks`). No usa credenciales: la cuenta y la región están en `cdk.json` y los valores de SSM se resuelven recién en deploy. Cada supresión de cdk-nag vive junto al recurso con su justificación.

### Deploy (al mergear a `main`)

`deploy.yml` asume por OIDC el rol `hop-hackathon-github-deploy` y corre `cdk diff` + `cdk deploy HopHackathonDev --exclusively`. El job solo corre si la ref es `main` (también con `workflow_dispatch`).

Sobre el rol: su trust acepta **únicamente** tokens de push a `main` del repo `dinocloud/hop` (ni environments, ni PRs, ni otras ramas) y solo puede asumir los roles de bootstrap de CDK de la región. Ojo: el rol de ejecución de CloudFormation del bootstrap (`cfn-exec-role`) tiene AdministratorAccess en la cuenta, como en cualquier bootstrap por defecto, así que **quien pueda mergear a `main` puede desplegar cualquier cosa en la cuenta compartida**. Por eso `main` tiene que estar protegida en GitHub: PR obligatorio con al menos una revisión y sin push directo.

**Setup único** (una sola vez, lo hace alguien con acceso a la cuenta):

1. Desplegar el rol OIDC. Es el único deploy manual del proyecto; reutiliza el proveedor OIDC de GitHub que ya existe en la cuenta.
   ```bash
   AWS_PROFILE=dino-dev npm run deploy:ci-role
   ```
2. Copiar el output `DeployRoleArn` y cargarlo en GitHub como **variable** `AWS_DEPLOY_ROLE_ARN` (Settings → Secrets and variables → Actions → Variables).
3. Proteger `main` en GitHub (Settings → Branches → Branch protection rule): PR obligatorio con 1 revisión, sin push directo, checks de CI requeridos. No es opcional: es la puerta de entrada al deploy.

A partir de ahí cada merge a `main` despliega. También se puede lanzar a mano desde Actions → Deploy → Run workflow.

## Envío de WhatsApp (`src/lib/whatsapp.ts`)

Un solo módulo para las dos Lambdas, sobre `SendWhatsAppMessage` de End User Messaging Social:

| Función | Cuándo | Ventana de 24 h |
|---|---|---|
| `sendTemplate(phone, name, params)` | Mensajes iniciados por HOP (aviso de paquete listo) | No aplica: siempre se puede |
| `sendText(phone, text)` | Respuestas del agente | Obligatoria: lanza `OutsideWindowError` si el cliente no escribió en las últimas 24 h |
| `sendLocation(phone, {lat, lng, name, address})` | Pin del Punto HOP | Obligatoria |

Detalles que importan:

- El destino se normaliza a E.164 **con `+`** (AWS lo exige). Un número sin `+` se rechaza: completarlo a ciegas podría convertir un número local en un E.164 válido de otro país. El `from` del webhook de Meta viene sin `+`; para esa fuente está `fromWaId` en `src/lib/phone.ts`.
- La ventana local se cierra 5 minutos antes que la de Meta, como margen para reintentos y relojes.
- Los textos de más de 4096 caracteres se parten en varios mensajes; los parámetros de plantilla se sanean (Meta rechaza vacíos, saltos de línea y tabs).
- El cliente del SDK no reintenta: `SendWhatsAppMessage` no es idempotente y un timeout después de aceptado duplicaría el mensaje.
- Configuración por variables de entorno que el stack llena: `ORIGINATION_PHONE_NUMBER_ID` (desde SSM), `TEMPLATE_NAME`, `TEMPLATE_LANGUAGE` (contexto `hop:templateLanguage`, tiene que coincidir con el idioma con el que se aprobó la plantilla) y `META_API_VERSION` (opcional).
- Los errores no guardan el número completo: Powertools vuelca las propiedades del error al log.

`src/lib/dynamo.ts` expone los repos tipados de las cuatro tablas. Para los mensajes entrantes: `claimMessage(messageId)` reclama el mensaje con un lease (tabla `hop-hackathon-inbound-messages`, TTL 7 días) y devuelve `false` si ya se procesó o se está procesando; `completeMessage` lo marca `DONE` al terminar. Si la Lambda falla a mitad de camino no se marca nada y el reintento lo retoma cuando vence el lease, así no se pierden respuestas. `touchInbound(phone, inboundAt)` renueva la ventana con la fecha del mensaje y asigna `sessionId`.

Prueba manual (el número va por argumento, nunca al repo):

```bash
AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 template paquete_listo "Ana" "Punto HOP Palermo" "5"
AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 text "hola desde HOP"     # requiere ventana abierta
AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 location                  # requiere ventana abierta
```

## Hook de estado del paquete

`POST /packages/{trackingId}/status` con header `x-api-key`. Body:

```json
{ "status": "READY_AT_HOP", "hopPointId": "hop-palermo", "deadlineDays": 5 }
```

| Campo | Valores | Obligatorio |
|---|---|---|
| `status` | `IN_TRANSIT` · `READY_AT_HOP` · `DELIVERED` · `RETURNED` | sí |
| `hopPointId` | id de `hop-hackathon-hop-points` | solo para `READY_AT_HOP` |
| `deadlineDays` | 1 a 30 | solo para `READY_AT_HOP` |

`hopPointId` y `deadlineDays` solo se aceptan con `READY_AT_HOP`.

Respuestas:

| Código | Cuándo |
|---|---|
| `202 { trackingId, status, notified, messageId?, duplicate? }` | Estado guardado. Con `READY_AT_HOP` se guarda `deadlineAt` (fin del día N en hora de Buenos Aires) y se envía `paquete_listo` con `[nombre, Punto HOP, días]`. |
| `400` | Body, path o Punto HOP inválidos. |
| `404` | El paquete no existe. |
| `409` | Transición no permitida (`DELIVERED` y `RETURNED` son terminales) o el paquete cambió entre la lectura y la escritura: reintentar. |
| `503` | El envío de la plantilla falló por una causa transitoria (throttling, timeout). El estado quedó guardado; reintentar es seguro. |

Garantías:
- **Idempotente**: un `READY_AT_HOP` repetido para el mismo punto no reenvía la plantilla ni corre el plazo (`duplicate: true`). Si cambia el punto, se avisa de nuevo con plazo nuevo.
- El resultado del aviso queda en el paquete (`readyNotificationStatus: SENT | FAILED`, `readyMessageId`, `readyNotificationError`).
- Si el envío falla de forma permanente (por ejemplo la plantilla todavía no está aprobada en Meta) responde `202` con `notified: false`, registra `FAILED` y emite la métrica `HopHackathon/TemplateSendFailed`, que tiene alarma (`hop-hackathon-template-send-failed`).
- La Lambda tiene timeout de 20 s y los clientes del SDK 5 s por request, siempre por debajo de los 29 s de API Gateway.

## Agente en AgentCore Runtime (`agent/`)

El agente de seguimiento para el cliente final corre en **Amazon Bedrock AgentCore Runtime** con **deploy de código directo** (runtime `NODE_22`): el bundle de `agent/src` se sube a S3 como asset y el runtime lo carga, sin contenedor ni Docker. Está escrito con `@strands-agents/sdk` (TypeScript) y el servidor del runtime lo da `bedrock-agentcore/runtime` (`/invocations`, `/ping`, sesión).

- **Contrato** (`src/lib/agent-contract.ts`): request `{ phone, text }`, response `{ text, location | null }`. Si viene `location`, la Lambda inbound manda además el pin de WhatsApp. El modelo devuelve JSON `{ text, hopPointId | null }`; la ubicación la arma el servidor desde DynamoDB, así el modelo no puede inventar coordenadas. Si el modelo no devuelve JSON válido, su texto va tal cual, sin pin. No se fuerza salida estructurada ni se tocan los parámetros de muestreo (los Claude recientes rechazan `toolChoice` forzado y temperaturas distintas de la de fábrica).
- **Límites**: 6 vueltas de tools, 4096 tokens de salida, 40 s por invocación (la Lambda tiene 60 s), ventana de 12 mensajes por sesión. Una sesión procesa de a un mensaje (los mensajes seguidos del mismo cliente se encolan) y, si una invocación falla, la sesión se descarta para no dejar un hilo inconsistente.
- **Tools** (`agent/src/tools.ts`): `get_my_packages` (usa el teléfono de la sesión, nunca uno que diga el usuario), `get_package_by_tracking` (solo si el paquete es del cliente) y `get_hop_point`. Las tools no devuelven teléfonos ni datos internos.
- **Sesión**: AgentCore aísla cada `sessionId` en su propia instancia; un agente en memoria por sesión conserva el hilo. La Lambda inbound usa el `sessionId` de la conversación.
- **Modelo**: contexto `hop:agentModelId` (`us.anthropic.claude-sonnet-5-5`), `maxTokens` explícito. El rol del runtime solo puede invocar ese perfil de inferencia y los foundation models de Claude a los que enruta.
- **Rol del runtime**: trust a `bedrock-agentcore.amazonaws.com` condicionado a esta cuenta y región, lectura de `Packages`/`HopPoints`, lectura del asset, logs del runtime, X-Ray y métricas del namespace `bedrock-agentcore`. Red `PUBLIC` solo por ser dev. Sin authorizer: el único caller es la Lambda, por SigV4.
- El ARN del runtime queda en el output `AgentRuntimeArn` y en SSM `/hop-hackathon/dev/app/agent-runtime-arn`.

Local:

```bash
npm run build:agent                       # agent/dist/index.js (CommonJS, ~2.5 MB)
npm run smoke:agent                       # carga el bundle en una carpeta sin node_modules, como en el runtime
cd agent/dist && PACKAGES_TABLE=x HOP_POINTS_TABLE=x CONVERSATIONS_TABLE=x INBOUND_MESSAGES_TABLE=x AWS_REGION=us-east-1 node index.js
curl -s localhost:8080/ping
curl -s -X POST localhost:8080/invocations -H 'content-type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: 0123456789abcdef0123456789abcdef0123' \
  -d '{"phone":"+5491112345678","text":"¿dónde está mi paquete?"}'
```

Después del deploy:

```bash
aws bedrock-agentcore invoke-agent-runtime --region us-east-1 \
  --agent-runtime-arn "$(aws ssm get-parameter --name /hop-hackathon/dev/app/agent-runtime-arn --query Parameter.Value --output text)" \
  --runtime-session-id "$(uuidgen)" \
  --payload "$(echo -n '{"phone":"+549...","text":"¿dónde está mi paquete?"}' | base64)" /dev/stdout
```

Si el runtime rechazara el entry point `index.js` para `NODE_22`, se ajusta con la prop `agentEntryPoint` del stack; el servidor cumple el contrato HTTP en el puerto 8080, que es el fallback seguro.

## Mensajes entrantes (`src/lambdas/inbound-router`)

SNS (End User Messaging Social) → `inbound-router` → AgentCore → respuesta por WhatsApp.

- **Evento**: el `Message` de SNS trae `whatsAppWebhookEntry`, el `entry` de la Cloud API de Meta como string JSON. Solo se procesan mensajes de texto. Otros tipos (imagen, audio) van a `InboundIgnored`; los `statuses` se cuentan en `InboundStatus` y un `failed` (por ejemplo 131047, fuera de ventana) se loguea con sus códigos y dispara `ReplyDeliveryFailed`. Elementos con forma inesperada van a `InboundInvalid` sin bloquear al resto; un sobre con formato desconocido va a `InboundParseError`. El `from` viene sin `+` y se normaliza con `fromWaId`. Parser tolerante por elemento en `src/lib/inbound-event.ts`.
- **Exactamente una vez**: `claimMessage(messageId)` con lease de 70 s (más que el timeout de la Lambda). `done` se descarta como duplicado; `in_progress` (una invocación anterior murió con el lease vivo) se relanza para que Lambda lo reintente más tarde en vez de perderlo; `completeMessage` al terminar; `releaseMessage` si falla antes de enviar algo.
- **Nunca dos respuestas**: una vez que salió algo por WhatsApp, un fallo posterior no relanza (log + `ReplyFailed`). Solo se reintenta si todavía no salió nada, el error es transitorio y no ambiguo (un timeout del envío puede haber llegado igual).
- **Conversación**: `touchInbound(phone, fechaDelMensaje)` abre la ventana de 24 h (nunca retrocede) y asigna el `sessionId` que se le pasa a AgentCore (así el agente conserva el hilo; el runtime procesa de a un mensaje por sesión). Un mensaje más viejo que la ventana (redrive tardío) no se contesta: `InboundStale`.
- **Respuesta**: `sendText` con el texto del agente y, si devolvió `location`, `sendLocation` con el pin del Punto HOP. Si el agente falla o responde en modo degradado, se manda el texto de disculpa (`AgentFailed`).
- **Tiempo**: Lambda 60 s. Cada mensaje recibe como máximo 40 s para el agente, acotado por lo que queda de la Lambda menos 12 s de margen; si quedan menos de 15 s no se arranca otro mensaje y se relanza para el reintento.
- **Alarmas**: `InboundParseError`, `ReplyFailed`, `ReplyDeliveryFailed` y `AgentFailed` > 0 en 5 minutos, además de la DLQ.

Probar sin teléfono (el número indicado recibe la respuesta real). Requiere `sns:Publish` sobre el topic (y `kms:GenerateDataKey` si el topic estuviera cifrado con una CMK). Ojo: el evento sintético abre la ventana local para ese número; si en Meta nunca escribió, el envío lo acepta AWS pero Meta lo rechaza de forma asíncrona (llega como `status: failed` con 131047 y dispara `ReplyDeliveryFailed`).

```bash
AWS_PROFILE=dino-dev npm run publish:inbound -- +5491112345678 "¿dónde está mi paquete?"
aws logs tail /aws/lambda/hop-hackathon-inbound-router --since 5m --follow
```

## Datos de prueba

```bash
AWS_PROFILE=dino-dev SEED_PHONES=+5491112345678,+5491187654321 npm run seed
```

Carga 3 Puntos HOP de CABA y 10 paquetes en distintos estados. Los primeros paquetes quedan asociados, en orden, a los teléfonos de `SEED_PHONES` (los del equipo, nunca en el repo). Es idempotente.

## Verificar después del deploy

```bash
export AWS_PROFILE=dino-dev AWS_REGION=us-east-1
API_URL=$(aws cloudformation describe-stacks --stack-name hop-hackathon-dev --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
KEY_ID=$(aws cloudformation describe-stacks --stack-name hop-hackathon-dev --query "Stacks[0].Outputs[?OutputKey=='HookApiKeyId'].OutputValue" --output text)
API_KEY=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --query value --output text)

# Datos cargados
aws dynamodb scan --table-name hop-hackathon-packages --max-items 3

# Hook (placeholder hasta que se mergee feat/package-status-hook)
curl -s -X POST "${API_URL}packages/HOP-0001/status" \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"status":"READY_AT_HOP","hopPointId":"hop-palermo","deadlineDays":5}'
```

## Criterios AWS que sigue el proyecto

- **IAM de mínimo privilegio**: permisos de DynamoDB por tabla y por acción, `SendWhatsAppMessage` acotado al ARN del número, roles propios por Lambda con escritura de logs limitada a su log group (sin `AWSLambdaBasicExecutionRole`). Un test del stack falla si aparece un `Resource: "*"` que no sea de X-Ray.
- **Nada hardcodeado**: IDs y ARNs desde SSM en deploy; teléfonos del equipo por variable de entorno.
- **Lambdas**: Node 24, arm64, bundling con esbuild (sin Docker), logs JSON con Powertools, X-Ray, retención de logs 14 días, concurrencia reservada de 10 (acota el impacto sobre el pool compartido), DLQ con alarma para los eventos de SNS.
- **API**: API key + usage plan con throttling y cuota, validación de body y path, access logs. El rol de CloudWatch de API Gateway es un setting a nivel cuenta que ya existe: el stack no lo toca.
- **DynamoDB**: on-demand, PITR, cifrado. `RemovalPolicy.DESTROY` a propósito para poder limpiar la cuenta compartida al terminar el hackathon.
- **cdk-nag** en cada synth.

## Limpieza al terminar el hackathon

1. `cdk destroy HopHackathonDev` (borra tablas, Lambdas, API, suscripción, DLQ).
2. `cdk destroy HopHackathonCi` y borrar la variable `AWS_DEPLOY_ROLE_ARN` en GitHub.
3. Lo de Lean (número, WABA, SSM, topic SNS) se da de baja aparte: el número tiene cargo mensual.
