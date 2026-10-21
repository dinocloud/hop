import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Repos } from '../../src/lib/dynamo.js';
import { InvalidPhoneError } from '../../src/lib/phone.js';
import { calendarDaysUntilInBuenosAires, formatDayInBuenosAires } from '../../src/lib/time.js';
import type { HopPoint, Package } from '../../src/lib/types.js';

/**
 * Tools de consulta del agente. Leen DynamoDB a través de los mismos repos que las Lambdas.
 *
 * El agente nunca ve el teléfono del cliente como entrada libre: `get_my_packages` usa el
 * teléfono de la sesión (viene del webhook de WhatsApp), así una persona no puede consultar
 * los paquetes de otra pidiéndoselo al modelo.
 */

export interface ToolDeps {
  repos: Repos;
  /** Teléfono E.164 del cliente que está escribiendo (el `from` de WhatsApp). */
  phone: string;
  now?: () => Date;
}

/**
 * Lo que el modelo ve de un paquete. Sin teléfono ni datos internos.
 * Las fechas van ya escritas en hora de Buenos Aires: el plazo vence a las 23:59 de BA, que en
 * ISO UTC es el día siguiente, y el modelo no tiene por qué saber convertirlo ni qué día es hoy.
 */
export function presentPackage(pkg: Package, now: Date = new Date()): Record<string, unknown> {
  const deadline = parseDate(pkg.deadlineAt);
  const scheduled = parseDate(pkg.scheduledAt);
  return {
    trackingId: pkg.trackingId,
    customerName: pkg.customerName,
    status: pkg.status,
    hopPointId: pkg.hopPointId ?? null,
    deadlineLocal: deadline ? formatDayInBuenosAires(deadline) : null,
    daysLeft: deadline ? calendarDaysUntilInBuenosAires(deadline, now) : null,
    scheduledLocal: scheduled ? formatDayInBuenosAires(scheduled) : null,
    updatedAt: pkg.updatedAt,
  };
}

function parseDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function presentHopPoint(hop: HopPoint): Record<string, unknown> {
  return {
    id: hop.id,
    name: hop.name,
    address: hop.address,
    lat: hop.lat,
    lng: hop.lng,
    openingHours: hop.openingHours,
  };
}

export function createTools(deps: ToolDeps) {
  const now = deps.now ?? (() => new Date());
  const getMyPackages = tool({
    name: 'get_my_packages',
    description:
      'Devuelve los paquetes del cliente que está escribiendo, del más reciente al más viejo. Usala siempre primero cuando pregunten por "mi paquete".',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(10).default(5).describe('Cantidad máxima de paquetes'),
    }),
    callback: async ({ limit }) => {
      try {
        const packages = await deps.repos.getPackagesByPhone(deps.phone, limit);
        return { packages: packages.map((pkg) => presentPackage(pkg, now())) };
      } catch (err) {
        if (err instanceof InvalidPhoneError) return { packages: [], error: 'Teléfono de la sesión inválido' };
        throw err;
      }
    },
  });

  const getPackageByTracking = tool({
    name: 'get_package_by_tracking',
    description:
      'Busca un paquete por su número de seguimiento (ej. HOP-0001). Solo devuelve el paquete si pertenece al cliente que está escribiendo.',
    inputSchema: z.object({
      trackingId: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{3,64}$/, 'Formato de tracking inválido')
        .describe('Número de seguimiento del paquete'),
    }),
    callback: async ({ trackingId }) => {
      const pkg = await deps.repos.getPackage(trackingId.toUpperCase());
      if (!pkg || pkg.phone !== deps.phone) return { found: false };
      return { found: true, package: presentPackage(pkg, now()) };
    },
  });

  const getHopPoint = tool({
    name: 'get_hop_point',
    description: 'Devuelve nombre, dirección, coordenadas y horarios de un Punto HOP a partir de su id (ej. hop-palermo).',
    inputSchema: z.object({
      hopPointId: z.string().trim().min(1).max(64).describe('Id del Punto HOP, tal como viene en el paquete'),
    }),
    callback: async ({ hopPointId }) => {
      const hop = await deps.repos.getHopPoint(hopPointId);
      if (!hop) return { found: false };
      return { found: true, hopPoint: presentHopPoint(hop) };
    },
  });

  return [getMyPackages, getPackageByTracking, getHopPoint];
}
