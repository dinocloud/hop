/**
 * Crea un paquete para un teléfono, sin tocar los que ya existen.
 *
 * `seed.ts` carga los 10 paquetes fijos y los reparte entre los teléfonos de `SEED_PHONES`,
 * así que sumar un teléfono obliga a resembrar todo y pisa el estado de las pruebas. Este
 * script agrega uno suelto, que es lo que hace falta cuando alguien se suma a la demo desde
 * otro celular.
 *
 * Uso (el número nunca va al repo):
 *   AWS_PROFILE=dino-dev npm run add:package -- +5491112345678
 *   AWS_PROFILE=dino-dev npm run add:package -- +5491112345678 --name Lean --point hop-belgrano --days 3
 *   AWS_PROFILE=dino-dev npm run add:package -- +5491112345678 --status IN_TRANSIT
 *
 * Opciones (todas con default razonable para la demo):
 *   --name <nombre>     nombre del cliente (default: "Cliente")
 *   --status <estado>   IN_TRANSIT | READY_AT_HOP | DELIVERED | RETURNED (default: READY_AT_HOP)
 *   --point <id>        id del Punto HOP (default: hop-palermo); se valida contra la tabla
 *   --days <n>          días de plazo, 1 a 30 (default: 5); solo con READY_AT_HOP
 *   --id <HOP-0042>     forzar el trackingId; por defecto se toma el mayor existente + 1
 *
 * No pisa un paquete existente: si el trackingId ya está, falla y avisa.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { normalizePhone } from '../src/lib/phone.js';
import { endOfDayInBuenosAires, formatDayInBuenosAires } from '../src/lib/time.js';
import { PACKAGE_STATUSES, type HopPoint, type Package, type PackageStatus } from '../src/lib/types.js';

const PREFIX = 'hop-hackathon';
const PACKAGES_TABLE = process.env.PACKAGES_TABLE ?? `${PREFIX}-packages`;
const HOP_POINTS_TABLE = process.env.HOP_POINTS_TABLE ?? `${PREFIX}-hop-points`;

interface Options {
  phone: string;
  customerName: string;
  status: PackageStatus;
  hopPointId: string;
  deadlineDays: number;
  trackingId?: string;
}

export function parseArgs(argv: string[]): Options {
  const [rawPhone, ...rest] = argv;
  if (!rawPhone || rawPhone.startsWith('--')) {
    throw new Error(
      'Falta el teléfono. Uso: npm run add:package -- <+549...> [--name N] [--status S] [--point P] [--days D] [--id HOP-0042]',
    );
  }

  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Opción mal formada cerca de "${key ?? ''}"`);
    flags.set(key.slice(2), value);
  }

  const status = (flags.get('status') ?? 'READY_AT_HOP') as PackageStatus;
  if (!PACKAGE_STATUSES.includes(status)) {
    throw new Error(`Estado inválido: "${status}". Valores: ${PACKAGE_STATUSES.join(' | ')}`);
  }

  const rawDays = flags.get('days');
  if (rawDays !== undefined && status !== 'READY_AT_HOP') {
    throw new Error('--days solo aplica con --status READY_AT_HOP');
  }
  const deadlineDays = Number(rawDays ?? 5);
  if (!Number.isInteger(deadlineDays) || deadlineDays < 1 || deadlineDays > 30) {
    throw new Error(`--days tiene que ser un entero de 1 a 30 (recibido: "${rawDays}")`);
  }

  const trackingId = flags.get('id');
  if (trackingId !== undefined && !/^[A-Z]+-\d{4,}$/.test(trackingId)) {
    throw new Error(`--id tiene que tener la forma HOP-0042 (recibido: "${trackingId}")`);
  }

  return {
    phone: normalizePhone(rawPhone),
    customerName: flags.get('name') ?? 'Cliente',
    status,
    hopPointId: flags.get('point') ?? 'hop-palermo',
    deadlineDays,
    trackingId,
  };
}

/** El mayor sufijo numérico de los `HOP-####` que ya existen, para seguir la numeración. */
export function nextTrackingId(existing: string[]): string {
  const max = existing.reduce((acc, id) => {
    const match = /^HOP-(\d+)$/.exec(id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `HOP-${String(max + 1).padStart(4, '0')}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

  // El Punto HOP tiene que existir: si no, el agente después no puede armar el pin de ubicación.
  const hop = await doc.send(new GetCommand({ TableName: HOP_POINTS_TABLE, Key: { id: opts.hopPointId } }));
  if (!hop.Item) {
    const all = await doc.send(new ScanCommand({ TableName: HOP_POINTS_TABLE, ProjectionExpression: 'id' }));
    const ids = (all.Items ?? []).map((i) => (i as Pick<HopPoint, 'id'>).id).join(', ');
    throw new Error(`No existe el Punto HOP "${opts.hopPointId}". Disponibles: ${ids || '(ninguno: corré npm run seed)'}`);
  }

  let trackingId = opts.trackingId;
  if (!trackingId) {
    const scan = await doc.send(new ScanCommand({ TableName: PACKAGES_TABLE, ProjectionExpression: 'trackingId' }));
    trackingId = nextTrackingId((scan.Items ?? []).map((i) => (i as Pick<Package, 'trackingId'>).trackingId));
  }

  const now = new Date();
  const pkg: Package = {
    trackingId,
    phone: opts.phone,
    customerName: opts.customerName,
    status: opts.status,
    hopPointId: opts.hopPointId,
    updatedAt: now.toISOString(),
  };
  if (opts.status === 'READY_AT_HOP') {
    pkg.deadlineAt = endOfDayInBuenosAires(now, opts.deadlineDays).toISOString();
  }

  try {
    await doc.send(
      new PutCommand({
        TableName: PACKAGES_TABLE,
        Item: pkg,
        ConditionExpression: 'attribute_not_exists(trackingId)',
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      throw new Error(`El paquete ${trackingId} ya existe. Pasá otro con --id, o dejá que lo numere solo.`, { cause: err });
    }
    throw err;
  }

  const hopName = (hop.Item as HopPoint).name;
  console.log(`Creado ${trackingId} para ${opts.phone}`);
  console.log(`  cliente: ${opts.customerName}`);
  console.log(`  estado:  ${opts.status} en ${hopName}`);
  if (pkg.deadlineAt) {
    console.log(`  plazo:   ${formatDayInBuenosAires(new Date(pkg.deadlineAt))} (${opts.deadlineDays} días)`);
  }
}

// Solo corre como script; los tests importan las funciones puras.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
}
