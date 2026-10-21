/**
 * Publica en el topic SNS de entrantes un evento sintético con el mismo formato que manda
 * AWS End User Messaging Social, para probar la Lambda inbound sin un teléfono.
 *
 * Uso (el número nunca va al repo):
 *   AWS_PROFILE=dino-dev npm run publish:inbound -- +5491112345678 "¿dónde está mi paquete?"
 *
 * El ARN del topic se lee de SSM `/hop-hackathon/<stage>/whatsapp/inbound-topic-arn` (o env
 * `INBOUND_TOPIC_ARN`). Atención: el teléfono recibe la respuesta real por WhatsApp.
 */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { buildInboundEvent } from '../src/lib/inbound-event.js';
import { normalizePhone } from '../src/lib/phone.js';

const PREFIX = 'hop-hackathon';
const STAGE = process.env.STAGE ?? 'dev';

async function resolveTopicArn(): Promise<string> {
  if (process.env.INBOUND_TOPIC_ARN) return process.env.INBOUND_TOPIC_ARN;
  const res = await new SSMClient({}).send(new GetParameterCommand({ Name: `/${PREFIX}/${STAGE}/whatsapp/inbound-topic-arn` }));
  if (!res.Parameter?.Value) throw new Error('No se pudo leer inbound-topic-arn de SSM');
  return res.Parameter.Value;
}

async function main(): Promise<void> {
  const [rawPhone, ...words] = process.argv.slice(2);
  if (!rawPhone || words.length === 0) {
    console.error('Uso: npm run publish:inbound -- <+549...> <texto del mensaje>');
    process.exit(2);
  }
  const from = normalizePhone(rawPhone);
  const message = buildInboundEvent({ from, text: words.join(' ') });
  const res = await new SNSClient({}).send(new PublishCommand({ TopicArn: await resolveTopicArn(), Message: message }));
  console.log('Publicado en SNS. MessageId:', res.MessageId);
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
