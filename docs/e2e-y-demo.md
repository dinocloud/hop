# Prueba E2E y guión de demo

Recorrido completo sobre el número de testing, y el guión para presentar.
Los tests unitarios cubren cada pieza por separado (189 en 15 archivos); acá se
verifica que encajan de punta a punta contra WhatsApp real.

Card: [Prueba E2E con número de testing + guión de demo](https://app.clickup.com/t/86e3pnw17)

## Estado

| Flujo | Estado |
|---|---|
| A — consulta (entrante → agente → texto + ubicación) | ✅ verificado 2026-10-22 |
| B — aviso proactivo (hook → plantilla) | ⏳ espera la plantilla aprobada en Meta |
| C — resolución desde el chat (`extend_deadline`) | ✅ verificado 2026-10-22 |

Del Flujo C se probó `extend_deadline`. Las otras tres acciones (`change_hop_point`,
`reschedule_delivery`, `request_return`) comparten el mismo camino —el agente confirma y
escribe en `Packages`— pero no se ejercitaron contra el stack.

## Antes de empezar

```bash
eval "$(aws configure export-credentials --profile AdministratorAccess-359328299440 --format env)"
export AWS_REGION=us-east-1
```

> El perfil SSO usa el formato `sso-session`, que CDK no resuelve solo. Con
> `export-credentials` quedan en el entorno y funcionan tanto para el CLI como para CDK.

| Requisito | Cómo se verifica |
|---|---|
| Stack desplegado | `aws cloudformation describe-stacks --stack-name hop-hackathon-dev` |
| Datos sembrados | `aws dynamodb scan --table-name hop-hackathon-packages --max-items 3` |
| Un teléfono con WhatsApp | el tuyo; va en `SEED_PHONES`, nunca al repo |

```bash
SEED_PHONES=+54911XXXXXXXX npm run seed
```

El seed deja los paquetes en orden: `HOP-0001` queda `READY_AT_HOP` en Palermo con 5 días,
`HOP-0002` en Caballito con 2, `HOP-0003` `IN_TRANSIT`. Los primeros van al primer teléfono
de `SEED_PHONES`.

Los IDs de WhatsApp se leen de SSM, no se pasan a mano:

```bash
aws ssm get-parameters-by-path --path /hop-hackathon/dev/whatsapp --query 'Parameters[].[Name,Value]' --output text
```

## Flujo A — consulta (entrante → agente → respuesta)

Es el que se puede probar siempre: lo dispara la persona, así que no necesita plantilla.

1. **Escribile al número desde tu teléfono**: `¿dónde está mi paquete?`
2. **Mirar las métricas** mientras tanto:
   ```bash
   aws logs tail /aws/lambda/hop-hackathon-inbound-router --since 2m --follow --format short
   ```
   El log es deliberadamente silencioso: en el camino feliz solo salen métricas EMF, no una
   traza paso a paso. Lo que se ve es `InboundProcessed: 1` cuando el mensaje se procesó, y
   después varios `InboundStatus: 1`, que son los `sent`/`delivered`/`read` de las respuestas.
   Los `WARN` y `ERROR` aparecen solo si algo falla (`InboundParseError`, `AgentFailed`,
   `ReplyFailed`, `ReplyDeliveryFailed`).
3. **Resultado esperado en el teléfono**: un texto con el estado y el punto, y si hay paquete
   listo, un segundo mensaje con la ubicación.
4. **Verificar que la conversación quedó registrada** (abre la ventana de 24 h y fija el
   `sessionId` que el agente usa para mantener el hilo):
   ```bash
   aws dynamodb scan --table-name hop-hackathon-conversations \
     --query 'Items[].{telefono:phone.S,sesion:sessionId.S}'
   ```

Medido el 2026-10-22: del mensaje a las dos respuestas entregadas, ~6 segundos.

### Probar el agente aislado

Antes de meter WhatsApp en el medio conviene invocar el runtime directo: si falla acá, el
problema es el agente o las tools, no la mensajería.

```bash
ARN=$(aws ssm get-parameter --name /hop-hackathon/dev/app/agent-runtime-arn --query Parameter.Value --output text)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$ARN" \
  --runtime-session-id "$(uuidgen | tr -d '-')0000" \
  --content-type application/json --accept application/json \
  --payload "$(printf '{"phone":"+54911XXXXXXXX","text":"¿dónde está mi paquete?"}' | base64)" /dev/stdout
```

> `--content-type application/json` **no es opcional**: sin él el runtime responde `415`.
> El `runtime-session-id` necesita 33 caracteres o más, así que un `uuidgen` pelado (36 con
> guiones, 32 sin) conviene rellenarlo como arriba.

Devuelve `{ text, location }`. La `location` solo aparece si el teléfono tiene un paquete
`READY_AT_HOP`; el modelo devuelve un `hopPointId` y el servidor arma el pin desde DynamoDB.

### Sin teléfono

El número indicado igual recibe la respuesta real:

```bash
npm run publish:inbound -- +54911XXXXXXXX "¿dónde está mi paquete?"
```

> El evento sintético abre la ventana **local**, no la de Meta. Si ese número nunca escribió
> al número de testing, AWS acepta el envío y Meta lo rechaza después: llega como
> `status: failed` con código `131047` y dispara `ReplyDeliveryFailed`. Para la demo, siempre
> escribir primero desde el teléfono real.

## Flujo B — aviso proactivo (hook → plantilla)

Depende de que `paquete_listo` esté aprobada en Meta.

```bash
API_URL=$(aws cloudformation describe-stacks --stack-name hop-hackathon-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
KEY_ID=$(aws cloudformation describe-stacks --stack-name hop-hackathon-dev \
  --query "Stacks[0].Outputs[?OutputKey=='HookApiKeyId'].OutputValue" --output text)
API_KEY=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --query value --output text)

curl -s -X POST "${API_URL}packages/HOP-0003/status" \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"status":"READY_AT_HOP","hopPointId":"hop-palermo","deadlineDays":5}' | jq .
```

**Esperado**: `202` con `notified: true` y un `messageId`, y la plantilla llega al teléfono.

Si vuelve `notified: false`, la plantilla no está aprobada todavía. El estado igual quedó
guardado y queda `readyNotificationStatus: FAILED` en el paquete; repetir el mismo POST
cuando Meta apruebe la reenvía.

Usar `HOP-0003` y no `HOP-0001`: el seed deja a `HOP-0001` ya en `READY_AT_HOP`, y un repetido
para el mismo punto responde `duplicate: true` sin reenviar nada.

## Flujo C — resolución desde el chat

Lo interesante para mostrar: la persona contesta el aviso y el agente resuelve sin humano.

| Qué escribir | Qué tiene que hacer |
|---|---|
| "no llego, ¿me das más días?" | `extend_deadline` — corre el plazo, mismo punto |
| "¿lo pueden mandar a Belgrano?" | `change_hop_point` — pasa a `IN_TRANSIT` en el punto nuevo |
| "mejor que llegue el viernes" | `reschedule_delivery` — `IN_TRANSIT` con `scheduledAt` |
| "devolvelo" | `request_return` — `RETURNED`, definitivo |

El agente confirma antes de ejecutar: primero pide el dato que falta (cuántos días), después
pide confirmación explícita, y recién ahí escribe. Hay que contestarle que sí.

Verificar que el cambio quedó escrito — esto es lo que separa "el agente dijo que lo hizo" de
"el agente lo hizo":

```bash
aws dynamodb get-item --table-name hop-hackathon-packages \
  --key '{"trackingId":{"S":"HOP-0001"}}' \
  --query 'Item.{estado:status.S,punto:hopPointId.S,plazo:deadlineAt.S,programado:scheduledAt.S}'
```

**Al leer `deadlineAt`, convertí a hora de Buenos Aires antes de juzgar si está bien.** El plazo
vence a las 23:59 de BA, que en UTC cae el día siguiente. En la corrida del 2026-10-22, extender
2 días desde el martes 27 dejó `2026-10-30T02:59:59Z`, que es **jueves 29/10 23:59 en BA** —
correcto, aunque el ISO diga 30.

```bash
python3 -c "
from datetime import datetime,timezone,timedelta
u=datetime.fromisoformat('2026-10-30T02:59:59+00:00')
print(u.astimezone(timezone(timedelta(hours=-3))))
"
```

## Guión de demo

Unos 6 minutos. Sembrar los datos **antes** y tener el teléfono en pantalla.

**1. El problema** (30 s)
Un paquete llega al Punto HOP y la persona no se entera, o se entera y no puede ir. Hoy eso
termina en una llamada al call center o en una devolución.

**2. El aviso llega solo** (1 min)
Correr el POST del Flujo B en vivo. La plantilla aparece en el teléfono: nombre, punto y
plazo. Señalar que lo disparó el sistema de envíos, no una persona.

**3. La consulta** (1 min 30 s)
Responder desde el teléfono: *"¿dónde está?"*. Llega el estado y el pin de ubicación.
Mostrar que el agente nunca pidió el número de tracking: usa el teléfono de la sesión.

**4. La resolución** (2 min)
*"no llego hasta el viernes, ¿me das más tiempo?"* → el agente ofrece extender, confirma y
lo hace. Mostrar el `get-item` con el `deadlineAt` nuevo.
Después: *"mejor mandámelo a Belgrano"* → cambia de punto y el paquete vuelve a `IN_TRANSIT`.

**5. Cómo está hecho** (1 min)
El diagrama del README. Tres puntos: todo serverless y por CDK; el agente corre en AgentCore
Runtime con deploy de código directo, sin contenedor; y el modelo nunca inventa coordenadas
—devuelve un `hopPointId` y el servidor arma el pin desde DynamoDB.

### Si algo falla en vivo

| Síntoma | Causa más probable | Qué hacer |
|---|---|---|
| "No encontré el paquete" | **estás escribiendo desde un teléfono sin paquetes asociados** | ver abajo |
| La plantilla no llega | no está aprobada en Meta | seguir con el Flujo A, que no la necesita |
| No contesta la consulta | ventana de 24 h cerrada | escribir desde el teléfono primero |
| Tarda y responde la disculpa | sesión de AgentCore levantando | reintentar; el primer mensaje después de 15 min de inactividad es el lento |
| Dos mensajes seguidos y el segundo se disculpa | se encolan por sesión y el segundo se queda sin tiempo | mandar de a uno en la demo |

El último es el único que conviene evitar activamente: **un mensaje por vez**, esperando la
respuesta. Está documentado en el README (ordenar de verdad necesita SQS FIFO, pendiente).

### El síntoma que más confunde: "no encontré el paquete"

Las tools filtran por el teléfono de la sesión: `get_my_packages` busca por ese teléfono y
`get_package_by_tracking` devuelve `found: false` si el paquete pertenece a otro. Es la
protección de privacidad funcionando —nadie consulta el paquete ajeno por número de
seguimiento— pero el mensaje no sugiere para nada la causa.

Pasó en una prueba real: los paquetes estaban sembrados para un teléfono y la consulta salió
desde otro. Se ve rápido comparando las dos tablas:

```bash
aws dynamodb scan --table-name hop-hackathon-conversations --query 'Items[].phone.S'
aws dynamodb scan --table-name hop-hackathon-packages --query 'Items[].phone.S' --output text | tr '\t' '\n' | sort -u
```

Si el teléfono que escribió no está en la segunda lista, creale un paquete sin resembrar:

```bash
npm run add:package -- +54911XXXXXXXX --name Lean --point hop-belgrano --days 3
```

**Antes de la demo**: confirmá desde qué teléfono vas a escribir y que tenga paquetes.
