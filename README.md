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

La plantilla `paquete_listo` tampoco la crea el stack: se crea una sola vez por API, ver [Plantilla de WhatsApp](#plantilla-de-whatsapp-paquete_listo).

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
templates/           paquete_listo.json (definición de la plantilla de WhatsApp)
test/                vitest: infra (assertions) + unit
```

## Requisitos

- Node 22+ y npm.
- AWS CLI v2 con el perfil SSO `dino-dev` (solo para seed y verificación manual; el deploy lo hace el pipeline).

```bash
npm ci
npm run typecheck   # tsc
npm run lint        # ESLint (typescript-eslint + nombres en camelCase)
npm run format      # Prettier (ancho 140, comillas simples); CI corre format:check
npm test            # vitest
npm run synth       # arma el bundle del agente y corre cdk synth --strict con cdk-nag (sin credenciales)
```

El `app` de `cdk.json` construye `agent/dist` antes de sintetizar, así que `synth`, `diff`, `deploy:ci-role` y `cdk watch` funcionan en un clone limpio y nunca suben un bundle viejo.

## CI/CD

### Validación (todas las ramas y PRs)

`ci.yml` corre typecheck, tests y `cdk synth` con **cdk-nag** (`AwsSolutionsChecks`). No usa credenciales: la cuenta y la región están en `cdk.json` y los valores de SSM se resuelven recién en deploy. Cada supresión de cdk-nag vive junto al recurso con su justificación.

### Deploy (al mergear a `main`)

`deploy.yml` asume por OIDC el rol `hop-hackathon-github-deploy` y corre `cdk diff` + `cdk deploy HopHackathonDev --exclusively`. El job solo corre si la ref es `main` (también con `workflow_dispatch`).

Sobre el rol: su trust acepta **únicamente** tokens de push a `main` del repo `dinocloud/hop` (ni environments, ni PRs, ni otras ramas) y solo puede asumir los roles de bootstrap de CDK de la región. Ojo: el rol de ejecución de CloudFormation del bootstrap (`cfn-exec-role`) tiene AdministratorAccess en la cuenta, como en cualquier bootstrap por defecto, así que **quien pueda mergear a `main` puede desplegar cualquier cosa en la cuenta compartida**. Por eso `main` tiene que estar protegida en GitHub: PR obligatorio con al menos una revisión y sin push directo.

El repo usa *immutable subjects* de OIDC (los repos nuevos de GitHub vienen así): el `sub` del token es `repo:dinocloud@20630168/hop@1417116948:ref:refs/heads/main`, no `repo:dinocloud/hop:...`. El prefijo está en el contexto `hop:githubSubjectPrefix` de `cdk.json`. Se puede consultar con `gh api repos/dinocloud/hop/actions/oidc/customization/sub` (campo `sub_claim_prefix`).

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
- Configuración por variables de entorno que el stack llena: `ORIGINATION_PHONE_NUMBER_ID` (desde SSM), `TEMPLATE_NAME`, `TEMPLATE_LANGUAGE` (contexto `hop:templateLanguage`, tiene que coincidir con el idioma con el que se aprobó la plantilla) y `META_API_VERSION` (contexto `hop:metaApiVersion`, hoy `v23.0`; AWS acepta la v20 en adelante y Meta retira cada versión a los dos años, más o menos).
- Los errores no guardan el número completo: Powertools vuelca las propiedades del error al log.

`src/lib/dynamo.ts` expone los repos tipados de las cuatro tablas. Para los mensajes entrantes: `claimMessage(messageId)` reclama el mensaje con un lease (tabla `hop-hackathon-inbound-messages`, TTL 7 días) y devuelve `false` si ya se procesó o se está procesando; `completeMessage` lo marca `DONE` al terminar. Si la Lambda falla a mitad de camino no se marca nada y el reintento lo retoma cuando vence el lease, así no se pierden respuestas. `touchInbound(phone, inboundAt)` renueva la ventana con la fecha del mensaje y asigna `sessionId`.

Prueba manual (el número va por argumento, nunca al repo):

```bash
AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 template paquete_listo "Ana" "Punto HOP Palermo" "5"
AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 text "hola desde HOP"     # requiere ventana abierta
AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 location                  # requiere ventana abierta
```

## Plantilla de WhatsApp (`paquete_listo`)

El aviso proactivo lo inicia la empresa, así que tiene que ser una plantilla aprobada por Meta. La definición está en `templates/paquete_listo.json`.

| Campo | Valor |
|---|---|
| Nombre | `paquete_listo` (contexto `hop:templateName`) |
| Idioma | `es_AR` (contexto `hop:templateLanguage`) |
| Categoría | `UTILITY` |
| Componentes | Solo cuerpo (`BODY`), sin header ni botones |

> Hola {{1}}, tu paquete ya está en {{2}}. Tenés {{3}} días para retirarlo. Si necesitás más tiempo, cambiar de punto o reprogramar, respondé este mensaje.

Las variables son posicionales y el hook las manda en este orden:

| Variable | Contenido | Origen |
|---|---|---|
| `{{1}}` | Nombre del cliente | `customerName` del paquete |
| `{{2}}` | Nombre del Punto HOP | `name` del Punto HOP |
| `{{3}}` | Días para retirar | `deadlineDays` del body del hook |

Si cambian el texto o el orden de las variables, hay que crear y aprobar una plantilla nueva y ajustar la llamada a `sendTemplate` en `src/lambdas/package-status-hook/handler.ts`. Si cambian el nombre o el idioma, también hay que actualizar el contexto en `cdk.json`.

Para crear la plantilla (en `dino-dev` ya está creada; esto sirve para recrearla):

```bash
export AWS_PROFILE=dino-dev AWS_REGION=us-east-1
WABA_ID=$(aws socialmessaging list-linked-whatsapp-business-accounts --query 'linkedAccounts[0].id' --output text)
aws socialmessaging create-whatsapp-message-template --id "$WABA_ID" --template-definition fileb://templates/paquete_listo.json
```

`--id` es el ID de AWS de la WABA (`waba-...`); el `waba-id` de SSM es el numérico de Meta. `fileb://` manda el archivo tal cual; si se pasa inline, AWS CLI v2 lo interpreta como base64.

Para ver el estado (pasa de `PENDING` a `APPROVED` y puede tardar de minutos a horas):

```bash
aws socialmessaging list-whatsapp-message-templates --id "$WABA_ID" \
  --query "templates[?templateName=='paquete_listo'].templateStatus" --output text
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
| `409` | El paquete cambió entre la lectura y la escritura: reintentar. |
| `422` | Transición no permitida (`DELIVERED` y `RETURNED` son terminales): no reintentar. |
| `503` | El envío de la plantilla falló por una causa transitoria (throttling, 5xx). El estado quedó guardado; reintentar es seguro. |

Garantías:
- **Idempotente**: un `READY_AT_HOP` repetido para el mismo punto no reenvía la plantilla ni corre el plazo (`duplicate: true`). Si cambia el punto, se avisa de nuevo con plazo nuevo. Un `DELIVERED` o `RETURNED` repetido (webhook reintentado) responde `202` con `duplicate: true` sin escribir.
- **Plazo y aviso coinciden**: cuando el aviso todavía no salió (por ejemplo un paquete que el seed dejó en `READY_AT_HOP`), el plazo se calcula de nuevo con los `deadlineDays` del body, que son los días que dice la plantilla.
- El resultado del aviso queda en el paquete (`readyNotificationStatus: SENT | FAILED`, `readyMessageId`, `readyNotificationError`). Si la plantilla sale pero falla ese registro, igual responde `notified: true` y lo deja en el log.
- Si el envío falla de forma permanente (por ejemplo la plantilla todavía no está aprobada en Meta) responde `202` con `notified: false`, registra `FAILED` y emite la métrica `HopHackathon/TemplateSendFailed`, que tiene alarma (`hop-hackathon-template-send-failed`). Los fallos transitorios no cuentan para esa métrica.
- Un timeout o corte de conexión durante el envío es ambiguo (el mensaje pudo salir): responde `202` con `notified: false` y no pide reintento, para no duplicar el aviso. Repetir el `READY_AT_HOP` a mano lo reenvía.
- La Lambda tiene timeout de 20 s y los clientes del SDK cortan a los 5 s por request (`throwOnRequestTimeout`), siempre por debajo de los 29 s de API Gateway.

## Agente en AgentCore Runtime (`agent/`)

El agente de seguimiento para el cliente final corre en **Amazon Bedrock AgentCore Runtime** con **deploy de código directo** (runtime `NODE_22`): el bundle de `agent/src` se sube a S3 como asset y el runtime lo carga, sin contenedor ni Docker. Está escrito con `@strands-agents/sdk` (TypeScript) y el servidor del runtime lo da `bedrock-agentcore/runtime` (`/invocations`, `/ping`, sesión).

- **Contrato** (`src/lib/agent-contract.ts`): request `{ phone, text }`, response `{ text, location | null }`. Si viene `location`, la Lambda inbound manda además el pin de WhatsApp. El modelo devuelve JSON `{ text, hopPointId | null }`; la ubicación la arma el servidor desde DynamoDB, así el modelo no puede inventar coordenadas, y solo hay pin si el cliente tiene un paquete `READY_AT_HOP` en ese punto. Si el modelo contesta en prosa, el texto va tal cual, sin pin. Si intenta un JSON que no se puede leer (después de escapar los saltos de línea), responde la disculpa: al cliente nunca le llega JSON crudo. No se fuerza salida estructurada ni se tocan los parámetros de muestreo (los Claude recientes rechazan `toolChoice` forzado y temperaturas distintas de la de fábrica).
- **Límites**: 6 vueltas de tools, 4096 tokens de salida, ventana de 12 mensajes por sesión y 30 s por pedido contados desde que llega, incluida la espera en la cola de la sesión. Queda por debajo de los 40 s del cliente en la Lambda inbound, así la disculpa llega antes de que el cliente corte. Si al salir de la cola quedan menos de 5 s, responde la disculpa sin invocar al modelo. Una sesión procesa de a un mensaje (los mensajes seguidos del mismo cliente se encolan) y, si una invocación falla, la sesión se descarta para no dejar un hilo inconsistente.
- **Tools de consulta** (`agent/src/tools.ts`):
  - `get_my_packages`: usa el teléfono de la sesión, nunca uno que diga el usuario;
  - `get_package_by_tracking`: solo si el paquete es del cliente;
  - `get_hop_point`;
  - `list_hop_points`: ordenados por cercanía al punto actual;
  - `get_calendar`: hoy y los próximos 14 días.

  Las tools no devuelven teléfonos ni datos internos.
- **Tools de resolución** (`agent/src/actions.ts`): extender el plazo, cambiar de punto, reprogramar y devolver. Ver [Acciones del agente](#acciones-del-agente-resolución-del-aviso). Las fechas van ya escritas en hora de Buenos Aires (`deadlineLocal`, `scheduledLocal`, `daysLeft`), porque el plazo vence a las 23:59 de BA, que en ISO UTC es el día siguiente.
- **Sesión**: AgentCore aísla cada `sessionId` en su propia instancia; un agente en memoria por sesión conserva el hilo. La Lambda inbound usa el `sessionId` de la conversación.
- **Modelo**: contexto `hop:agentModelId` (`us.anthropic.claude-sonnet-5-5`), `maxTokens` explícito y effort `low` (`output_config.effort` por `additionalModelRequestFields`): Sonnet 5.5 piensa por defecto con effort `high`, que en un chat de seguimiento solo suma latencia. El rol del runtime solo puede invocar ese perfil de inferencia y los foundation models de Claude a los que enruta.
- **Rol del runtime**: trust a `bedrock-agentcore.amazonaws.com` condicionado a esta cuenta y región, lectura y `UpdateItem` de `Packages`, `GetItem`/`Scan` de `HopPoints`, lectura del asset, logs del runtime, X-Ray y métricas del namespace `bedrock-agentcore`. Red `PUBLIC` solo por ser dev. Sin authorizer: el único caller es la Lambda, por SigV4.
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
# --content-type es obligatorio: sin él el runtime devuelve 415.
# El session id necesita 33 caracteres o más, así que uuidgen pelado no alcanza.
aws bedrock-agentcore invoke-agent-runtime --region us-east-1 \
  --agent-runtime-arn "$(aws ssm get-parameter --name /hop-hackathon/dev/app/agent-runtime-arn --query Parameter.Value --output text)" \
  --runtime-session-id "$(uuidgen | tr -d '-')0000" \
  --content-type application/json --accept application/json \
  --payload "$(echo -n '{"phone":"+549...","text":"¿dónde está mi paquete?"}' | base64)" /dev/stdout
```

CloudFormation acepta `NODE_22` en `CodeConfiguration.Runtime` con un entry point `.js` en la raíz del zip, que es lo que arma el bundle único de esbuild.

### Acciones del agente (resolución del aviso)

Cuando la persona responde al aviso "paquete listo", el agente resuelve sin pasar por un humano:

| Tool | Qué hace | Cuándo se puede | Qué queda en `Packages` |
|---|---|---|---|
| `extend_deadline(trackingId, days)` | Suma de 1 a 7 días al plazo | `READY_AT_HOP` | `deadlineAt` = fin del día N en BA; estado y punto sin cambios |
| `change_hop_point(trackingId, hopPointId)` | Cambia de Punto HOP | `READY_AT_HOP` o `IN_TRANSIT` | `IN_TRANSIT`, `hopPointId` nuevo, sin `deadlineAt` ni `readyNotification*` |
| `reschedule_delivery(trackingId, date)` | Reprograma para otra fecha, de mañana a 14 días | `READY_AT_HOP` o `IN_TRANSIT` | `IN_TRANSIT`, `scheduledAt` a las 12:00 de BA, sin `deadlineAt` ni `readyNotification*` |
| `request_return(trackingId)` | Devuelve al remitente (definitivo) | `READY_AT_HOP` o `IN_TRANSIT` | `RETURNED`, sin `deadlineAt` ni `readyNotification*` |

Reglas:
- **Dos pasos.**
  - Con `confirmed: false` la tool devuelve un preview sin escribir (la fecha nueva, el punto nuevo, el aviso de que la devolución es definitiva), y el agente le pregunta al cliente si confirma.
  - Con `confirmed: true` escribe, pero solo si ese mismo preview se mostró en uno de los dos mensajes anteriores del cliente (el siguiente, o el otro si hubo una aclaración). No vale confirmar en el mismo turno, antes de que el cliente lo vea, ni con un preview viejo.
- **Solo paquetes del teléfono de la sesión.** Si el paquete cambió entre el preview y la confirmación, no escribe y pide volver a consultarlo.
- **Plazo vencido:** si ya venció, extender cuenta los días desde hoy.
- **Cambiar de punto o reprogramar deja el paquete en camino.** Cuando el sistema de envíos lo marca `READY_AT_HOP`, el hook manda el aviso de nuevo, con plazo nuevo.
- **Si tiene más de un paquete listo o en camino**, el agente pregunta cuál antes de hacer nada. Si piden otra cosa, dice qué sí puede hacer.

Conversaciones de ejemplo. Son respuestas reales del modelo, abreviadas, corridas contra Bedrock con datos en memoria. "Hoy" es miércoles 21 de octubre:

**Extender el plazo** (HOP-0001, listo en Palermo, vence el jueves 22):
> **Cliente:** Hola, necesito 3 días más para retirar mi paquete
> **Bot:** Hola Ana. Tu paquete HOP-0001 está listo para retirar en Punto HOP Palermo (Av. Santa Fe 3253) y vence mañana, jueves 22 de octubre. ¿Extiendo el plazo 3 días, hasta el domingo 25 de octubre?
> **Cliente:** sí
> **Bot:** Listo, extendí el plazo. Ahora podés retirar tu paquete HOP-0001 hasta el domingo 25 de octubre (te quedan 4 días).

Resultado: `deadlineAt` pasa de `2026-10-23T02:59:59.000Z` a `2026-10-26T02:59:59.000Z`. El estado y `hopPointId` no cambian.

**Cambiar de punto** (el mismo paquete):
> **Cliente:** ¿Lo puedo retirar en otro punto más cerca de Belgrano?
> **Bot:** Sí, hay un Punto HOP Belgrano en Av. Cabildo 2040 (Lun a Sáb 10 a 19). Ojo: el paquete volvería a quedar en camino hasta que llegue ahí, y te avisan con un plazo nuevo. ¿Confirmás el cambio a Punto HOP Belgrano?
> **Cliente:** Belgrano
> **Bot:** Para estar seguros: ¿confirmás que cambie el paquete HOP-0001 al Punto HOP Belgrano (Av. Cabildo 2040)? Respondeme "sí" y lo hago.
> **Cliente:** dale
> **Bot:** Listo, cambié tu paquete HOP-0001 al Punto HOP Belgrano. Ahora está en camino y, cuando llegue, te avisamos con el nuevo plazo de retiro.

Resultado: `status: IN_TRANSIT`, `hopPointId: hop-belgrano`, sin `deadlineAt` ni `readyNotificationStatus`.

**Reprogramar** (HOP-0002, listo en Caballito):
> **Cliente:** No voy a poder ir a buscarlo, ¿me lo podés reprogramar para el lunes?
> **Bot:** Dale. Reprogramo la entrega de tu paquete HOP-0002 para el lunes 26 de octubre y queda en camino. ¿Confirmás?
> **Cliente:** sí, confirmo
> **Bot:** Listo, Bruno. Reprogramé tu paquete HOP-0002 para el lunes 26 de octubre.

Resultado: `status: IN_TRANSIT`, `scheduledAt: 2026-10-26T15:00:00.000Z`, sin `deadlineAt`.

**Devolver** (HOP-0003, listo en Belgrano):
> **Cliente:** quiero devolverlo
> **Bot:** Si lo devolvemos al remitente, es definitivo y ya no vas a poder retirarlo. ¿Confirmás la devolución?
> **Cliente:** no, mejor no
> **Bot:** Listo, no devolví nada. Tu paquete HOP-0003 sigue disponible en Punto HOP Belgrano hasta el sábado 24 de octubre.
> **Cliente:** pensándolo bien sí, devolvelo
> **Bot:** Dale. Te confirmo antes de hacerlo: devolver el paquete HOP-0003 al remitente es definitivo y ya no vas a poder retirarlo. ¿Confirmás la devolución?
> **Cliente:** sí
> **Bot:** Listo, el paquete HOP-0003 quedó devuelto al remitente. Ya no está disponible para retirar en el Punto HOP.

Resultado: con el "no" no se escribe nada; con el último "sí", `status: RETURNED`.

## Mensajes entrantes (`src/lambdas/inbound-router`)

SNS (End User Messaging Social) → `inbound-router` → AgentCore → respuesta por WhatsApp.

- **Evento**: el `Message` de SNS trae `whatsAppWebhookEntry`, el `entry` de la Cloud API de Meta como string JSON. Se procesan los mensajes de texto y los taps en botones (respuesta rápida de una plantilla, botones y listas interactivas), que le llegan al agente como texto. A un audio, imagen, video, documento, sticker, ubicación o contacto se le contesta un texto fijo ("por ahora solo puedo leer mensajes de texto", `InboundUnsupported`); las reacciones, los mensajes de sistema y los textos vacíos se ignoran (`InboundIgnored`). Los `statuses` se cuentan en `InboundStatus` y un `failed` (por ejemplo 131047, fuera de ventana) se loguea con sus códigos y dispara `ReplyDeliveryFailed`. Elementos con forma inesperada van a `InboundInvalid` sin bloquear al resto; un sobre con formato desconocido va a `InboundParseError`. El `from` viene sin `+` y se normaliza con `fromWaId`. Parser tolerante por elemento en `src/lib/inbound-event.ts`.
- **Exactamente una vez**: `claimMessage(messageId)` con lease de 70 s (más que el timeout de la Lambda). `done` se descarta como duplicado; `in_progress` (una invocación anterior murió con el lease vivo) se relanza para que Lambda lo reintente más tarde en vez de perderlo; `completeMessage` al terminar; `releaseMessage` si falla antes de enviar algo.
- **Nunca dos respuestas**: una vez que salió algo por WhatsApp, un fallo posterior no relanza (log + `ReplyFailed`). Solo se reintenta si todavía no salió nada, el error es transitorio y no ambiguo (un timeout del envío puede haber llegado igual).
- **Conversación**: `touchInbound(phone, fechaDelMensaje)` abre la ventana de 24 h (nunca retrocede) y asigna el `sessionId` que se le pasa a AgentCore (así el agente conserva el hilo; el runtime procesa de a un mensaje por sesión). Un mensaje más viejo que la ventana (redrive tardío) no se contesta: `InboundStale`.
- **Respuesta**: `sendText` con el texto del agente y, si devolvió `location`, `sendLocation` con el pin del Punto HOP. Si el agente falla o responde en modo degradado, se manda el texto de disculpa (`AgentFailed`).
- **AgentCore**: el 409 `RetryableConflictException` aparece cuando la sesión se está levantando (dos mensajes seguidos en el primer contacto, o después de 15 min sin actividad). Ese error y el throttling se reintentan con esperas de 250, 500 y 1000 ms, dentro del mismo timeout: AgentCore no procesó el pedido, así que no se duplica nada.
- **Tiempo**: Lambda 60 s. Cada mensaje recibe como máximo 40 s para el agente, acotado por lo que queda de la Lambda menos 12 s de margen; si quedan menos de 15 s no se arranca otro mensaje y se relanza para el reintento.
- **Mensajes seguidos**: cada mensaje dispara su propia Lambda. El runtime los encola por sesión, pero no garantiza el orden de llegada, y la espera en la cola cuenta contra el tiempo del segundo mensaje: si no alcanza, ese mensaje recibe la disculpa. Para ordenarlos de verdad hace falta SQS FIFO con `MessageGroupId=phone` (pendiente).
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

Para sumar un teléfono sin resembrar todo (alguien que se suma a la demo desde otro celular):

```bash
AWS_PROFILE=dino-dev npm run add:package -- +5491112345678 --name Lean --point hop-belgrano --days 3
```

Crea un paquete suelto siguiendo la numeración existente (`HOP-0011`, `HOP-0012`...), valida que el Punto HOP exista y no pisa nada: si el `trackingId` ya está, falla. Opciones en el encabezado de `scripts/add-package.ts`.

> Resembrar con `SEED_PHONES` ampliado también funciona, pero reparte de nuevo los 10 paquetes fijos entre todos los teléfonos y reescribe los plazos, así que se pierde el estado de las pruebas en curso.

## Verificar después del deploy

Para el recorrido completo y el guión de demo, ver [docs/e2e-y-demo.md](docs/e2e-y-demo.md).

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

> Excepción conocida: el log group del runtime de AgentCore (`/aws/bedrock-agentcore/runtimes/<id>-DEFAULT`)
> lo crea el servicio y queda **sin retención**. No se declara en el stack porque CloudFormation
> no adopta un log group existente y el deploy entero aborta con `AlreadyExists`. `LogRetention`
> lo resolvería, pero su Lambda pide `logs:PutRetentionPolicy` sobre `*`, que el proyecto no admite.
> Pendiente de resolver; mientras tanto se fija a mano (ver comentario en `infra/lib/hop-stack.ts`).

## Limpieza al terminar el hackathon

1. `cdk destroy HopHackathonDev` (borra tablas, Lambdas, API, suscripción, DLQ).
2. `cdk destroy HopHackathonCi` y borrar la variable `AWS_DEPLOY_ROLE_ARN` en GitHub.
3. Lo de Lean (número, WABA, SSM, topic SNS) se da de baja aparte: el número tiene cargo mensual.
