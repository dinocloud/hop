/**
 * Carga datos sintéticos en DynamoDB: 3 Puntos HOP de CABA y ~10 paquetes.
 *
 * Uso:
 *   AWS_PROFILE=dino-dev SEED_PHONES=+5491112345678,+5491187654321 npm run seed
 *
 * - `SEED_PHONES`: teléfonos del equipo (E.164 con `+`), separados por coma. Nunca van al repo.
 *   Si no se define, se usa un número claramente ficticio y se avisa.
 * - Idempotente: las claves son fijas, correrlo dos veces no duplica nada (solo se renuevan las fechas).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { HopPoint, Package, PackageStatus } from '../src/lib/types.js';

const PREFIX = 'hop-hackathon';
const PACKAGES_TABLE = process.env.PACKAGES_TABLE ?? `${PREFIX}-packages`;
const HOP_POINTS_TABLE = process.env.HOP_POINTS_TABLE ?? `${PREFIX}-hop-points`;
const FAKE_PHONE = '+5491100000000';

const E164 = /^\+[1-9]\d{7,14}$/;

export function parseSeedPhones(raw: string | undefined): string[] {
  const phones = (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const phone of phones) {
    if (!E164.test(phone)) {
      throw new Error(`Teléfono inválido en SEED_PHONES: "${phone}". Formato esperado: +5491112345678`);
    }
  }
  return phones.length > 0 ? phones : [FAKE_PHONE];
}

export const HOP_POINTS: HopPoint[] = [
  {
    id: 'hop-palermo',
    name: 'Punto HOP Palermo',
    address: 'Av. Santa Fe 3253, CABA',
    lat: -34.5885,
    lng: -58.4106,
    openingHours: 'Lun a Vie 9 a 20, Sáb 10 a 14',
  },
  {
    id: 'hop-caballito',
    name: 'Punto HOP Caballito',
    address: 'Av. Rivadavia 5100, CABA',
    lat: -34.6186,
    lng: -58.4341,
    openingHours: 'Lun a Vie 9 a 18, Sáb 9 a 13',
  },
  {
    id: 'hop-belgrano',
    name: 'Punto HOP Belgrano',
    address: 'Av. Cabildo 2040, CABA',
    lat: -34.5614,
    lng: -58.4567,
    openingHours: 'Lun a Sáb 10 a 19',
  },
];

function daysFromNow(days: number, now: Date): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function buildPackages(phones: string[], now = new Date()): Package[] {
  const names = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elena', 'Facundo', 'Gabriela', 'Hernán', 'Inés', 'Julián'];
  const specs: Array<Pick<Package, 'status' | 'hopPointId'> & { deadlineDays?: number; scheduledDays?: number }> = [
    { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineDays: 5 },
    { status: 'READY_AT_HOP', hopPointId: 'hop-caballito', deadlineDays: 2 },
    { status: 'IN_TRANSIT', hopPointId: 'hop-belgrano' },
    { status: 'READY_AT_HOP', hopPointId: 'hop-belgrano', deadlineDays: 7 },
    { status: 'IN_TRANSIT', hopPointId: 'hop-palermo', scheduledDays: 1 },
    { status: 'DELIVERED', hopPointId: 'hop-caballito' },
    { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineDays: 1 },
    { status: 'RETURNED', hopPointId: 'hop-belgrano' },
    { status: 'IN_TRANSIT', hopPointId: 'hop-caballito' },
    { status: 'DELIVERED', hopPointId: 'hop-palermo' },
  ];

  return specs.map((spec, i) => {
    const updatedAt = new Date(now.getTime() - i * 60 * 60 * 1000).toISOString();
    const pkg: Package = {
      trackingId: `HOP-${String(i + 1).padStart(4, '0')}`,
      // Los primeros paquetes van a los teléfonos reales del equipo, en orden.
      phone: phones[i % phones.length] ?? FAKE_PHONE,
      customerName: names[i] ?? `Cliente ${i + 1}`,
      status: spec.status as PackageStatus,
      hopPointId: spec.hopPointId,
      updatedAt,
    };
    if (spec.deadlineDays !== undefined) pkg.deadlineAt = daysFromNow(spec.deadlineDays, now);
    if (spec.scheduledDays !== undefined) pkg.scheduledAt = daysFromNow(spec.scheduledDays, now);
    return pkg;
  });
}

async function batchPut(doc: DynamoDBDocumentClient, table: string, items: object[]): Promise<void> {
  // BatchWrite admite hasta 25 ítems por llamada.
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let unprocessed: Record<string, unknown> | undefined = {
      [table]: chunk.map((item) => ({ PutRequest: { Item: item } })),
    };
    let attempts = 0;
    while (unprocessed && Object.keys(unprocessed).length > 0) {
      if (attempts > 5) throw new Error(`No se pudieron escribir todos los ítems en ${table}`);
      // Backoff exponencial para los ítems no procesados (throttling).
      if (attempts > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempts));
      attempts++;
      const res = await doc.send(new BatchWriteCommand({ RequestItems: unprocessed as never }));
      unprocessed = res.UnprocessedItems as Record<string, unknown> | undefined;
    }
  }
}

async function main(): Promise<void> {
  const phones = parseSeedPhones(process.env.SEED_PHONES);
  if (phones[0] === FAKE_PHONE) {
    console.warn('SEED_PHONES no definido: los paquetes quedan asociados a un número ficticio.');
  }
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const packages = buildPackages(phones);

  await batchPut(doc, HOP_POINTS_TABLE, HOP_POINTS);
  await batchPut(doc, PACKAGES_TABLE, packages);

  console.log(`OK: ${HOP_POINTS.length} Puntos HOP en ${HOP_POINTS_TABLE}, ${packages.length} paquetes en ${PACKAGES_TABLE}`);
  console.table(packages.map((p) => ({ trackingId: p.trackingId, status: p.status, hopPointId: p.hopPointId })));
}

// Solo corre como script; los tests importan las funciones puras.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
