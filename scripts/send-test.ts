/**
 * Envía un mensaje de prueba por WhatsApp para verificar la lib de envío a mano.
 *
 * Uso (el número nunca va al repo):
 *   AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 text "hola desde HOP"
 *   AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 template paquete_listo "Ana" "Punto HOP Palermo" "5"
 *   AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 location
 *
 * Configuración (todas opcionales, mismos nombres que las Lambdas):
 *   STAGE (default dev), PACKAGES_TABLE, HOP_POINTS_TABLE, CONVERSATIONS_TABLE, INBOUND_MESSAGES_TABLE,
 *   ORIGINATION_PHONE_NUMBER_ID (si falta se lee de SSM `/hop-hackathon/<stage>/whatsapp/aws-phone-number-id`),
 *   TEMPLATE_LANGUAGE, META_API_VERSION.
 * Texto y ubicación exigen que ese teléfono haya escrito al número en las últimas 24 h
 * (se lee la tabla de conversaciones).
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createRepos } from '../src/lib/dynamo.js';
import { createWhatsAppSender } from '../src/lib/whatsapp.js';

const PREFIX = 'hop-hackathon';
const STAGE = process.env.STAGE ?? 'dev';

async function resolveOriginationPhoneNumberId(): Promise<string> {
  if (process.env.ORIGINATION_PHONE_NUMBER_ID) return process.env.ORIGINATION_PHONE_NUMBER_ID;
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: `/${PREFIX}/${STAGE}/whatsapp/aws-phone-number-id` }));
  if (!res.Parameter?.Value) throw new Error('No se pudo leer aws-phone-number-id de SSM');
  return res.Parameter.Value;
}

async function main(): Promise<void> {
  const [phone, kind = 'text', ...rest] = process.argv.slice(2);
  if (!phone) {
    console.error('Uso: npm run send:test -- <+549...> [text <mensaje> | template <nombre> <param...> | location]');
    process.exit(2);
  }

  const repos = createRepos({
    tables: {
      packages: process.env.PACKAGES_TABLE ?? `${PREFIX}-packages`,
      hopPoints: process.env.HOP_POINTS_TABLE ?? `${PREFIX}-hop-points`,
      conversations: process.env.CONVERSATIONS_TABLE ?? `${PREFIX}-conversations`,
      inboundMessages: process.env.INBOUND_MESSAGES_TABLE ?? `${PREFIX}-inbound-messages`,
    },
  });
  const sender = createWhatsAppSender({
    originationPhoneNumberId: await resolveOriginationPhoneNumberId(),
    getConversation: repos.getConversation,
  });

  let result;
  switch (kind) {
    case 'text':
      result = await sender.sendText(phone, rest.join(' ') || 'Hola desde HOP (prueba)');
      break;
    case 'template': {
      const [name, ...params] = rest;
      if (!name) throw new Error('Falta el nombre de la plantilla');
      result = await sender.sendTemplate(phone, name, params);
      break;
    }
    case 'location':
      result = await sender.sendLocation(phone, {
        lat: -34.5885,
        lng: -58.4106,
        name: 'Punto HOP Palermo',
        address: 'Av. Santa Fe 3253, CABA',
      });
      break;
    default:
      throw new Error(`Tipo desconocido: ${kind}`);
  }
  console.log('Enviado. messageId:', result.messageId ?? '(sin id)');
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
