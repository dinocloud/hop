/**
 * Envía un mensaje de prueba por WhatsApp para verificar la lib de envío a mano.
 *
 * Uso (el número nunca va al repo):
 *   AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 text "hola desde HOP"
 *   AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 template paquete_listo "Ana" "Punto HOP Palermo" "5"
 *   AWS_PROFILE=dino-dev npm run send:test -- +5491112345678 location
 *
 * El ID del número se lee de SSM (`/hop-hackathon/dev/whatsapp/aws-phone-number-id`) si no
 * está en `PHONE_NUMBER_ID`. Texto y ubicación exigen que ese teléfono haya escrito al número
 * en las últimas 24 h (se lee la tabla de conversaciones).
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createRepos } from '../src/lib/dynamo.js';
import { createWhatsAppSender } from '../src/lib/whatsapp.js';

const PREFIX = 'hop-hackathon';

async function resolvePhoneNumberId(): Promise<string> {
  if (process.env.PHONE_NUMBER_ID) return process.env.PHONE_NUMBER_ID;
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: `/${PREFIX}/dev/whatsapp/aws-phone-number-id` }));
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
      packages: `${PREFIX}-packages`,
      hopPoints: `${PREFIX}-hop-points`,
      conversations: `${PREFIX}-conversations`,
    },
  });
  const sender = createWhatsAppSender({
    phoneNumberId: await resolvePhoneNumberId(),
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
