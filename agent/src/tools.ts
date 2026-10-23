import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { TrackingIdTakenError, type Repos } from '../../src/lib/dynamo.js';
import { InvalidPhoneError } from '../../src/lib/phone.js';
import { calendarDaysUntilInBuenosAires, endOfDayInBuenosAires, formatDayInBuenosAires, isoDateInBuenosAires } from '../../src/lib/time.js';
import type { HopPoint, Package, PackageStatus } from '../../src/lib/types.js';

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

/** Días que muestra `get_calendar`: cubren la ventana en la que se puede reprogramar. */
export const CALENDAR_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;

/** Distancia en línea recta (haversine) entre dos Puntos HOP, redondeada a 100 m. */
function distanceKm(from: HopPoint, to: HopPoint): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/** Plazo por defecto de un envío registrado desde el chat. */
export const DEFAULT_DEADLINE_DAYS = 5;
/** Intentos antes de rendirse si el tracking al azar choca con uno existente. */
export const CREATE_ATTEMPTS = 5;

/**
 * `HOP-` + 4 dígitos al azar desde 1000, para no pisar la numeración baja del seed
 * (`HOP-0001`...) ni la de `scripts/add-package.ts`.
 */
export function randomTrackingId(): string {
  return `HOP-${1000 + Math.floor(Math.random() * 9000)}`;
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

  const listHopPoints = tool({
    name: 'list_hop_points',
    description:
      'Lista los Puntos HOP. Con nearHopPointId (el punto actual del paquete) los ordena del más cercano al más lejano: usala para ofrecer opciones antes de cambiar de punto.',
    inputSchema: z.object({
      nearHopPointId: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .optional()
        .describe('Id del Punto HOP de referencia, normalmente el actual del paquete'),
    }),
    callback: async ({ nearHopPointId }) => {
      const points = await deps.repos.listHopPoints();
      const reference = points.find((p) => p.id === nearHopPointId);
      if (!reference) return { hopPoints: points.map(presentHopPoint) };
      const byDistance = points.map((p) => ({ ...presentHopPoint(p), distanceKm: distanceKm(reference, p) }));
      return { hopPoints: byDistance.sort((a, b) => a.distanceKm - b.distanceKm) };
    },
  });

  const getCalendar = tool({
    name: 'get_calendar',
    description:
      'Devuelve la fecha de hoy y la de los próximos 14 días en hora de Buenos Aires. Usala para entender fechas que diga el cliente ("el lunes", "pasado mañana") antes de reprogramar.',
    inputSchema: z.object({}),
    callback: async () => {
      const today = now();
      return {
        today: formatDayInBuenosAires(today),
        todayDate: isoDateInBuenosAires(today),
        days: Array.from({ length: CALENDAR_DAYS }, (_, i) => {
          // Buenos Aires no tiene horario de verano: sumar 24 h siempre es el día siguiente.
          const day = new Date(today.getTime() + (i + 1) * DAY_MS);
          return { date: isoDateInBuenosAires(day), label: formatDayInBuenosAires(day) };
        }),
      };
    },
  });

  /**
   * Registra un envío a nombre de quien está escribiendo.
   *
   * Cubre dos situaciones: que la persona pida explícitamente enviar un paquete, y que escriba
   * sin tener ninguno asociado (ahí el agente lo registra sin preguntar, para que tenga algo
   * que seguir). Siempre usa el teléfono de la sesión, nunca uno que diga el usuario, igual que
   * `get_my_packages`.
   *
   * Nota de alcance: en una operación real el alta la hace el sistema de envíos, no el cliente.
   * Acá existe para que cualquiera pueda usar el bot de punta a punta por su cuenta.
   */
  const sendPackage = tool({
    name: 'send_package',
    description:
      'Registra un envío nuevo a nombre de quien está escribiendo, en camino al Punto HOP de destino. ' +
      'Usalo cuando la persona quiere enviar un paquete. Queda IN_TRANSIT hasta que confirme que lo dejó ' +
      '(confirm_dropoff). No pidas el teléfono: se usa el de la conversación.',
    inputSchema: z.object({
      hopPointId: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .optional()
        .describe('Punto HOP de destino. Si la persona no lo eligió, omitilo y se asigna uno.'),
      arrived: z
        .boolean()
        .optional()
        .describe('true solo si el paquete ya está en el Punto HOP y el cliente lo va a retirar (destinatario, no remitente)'),
      deadlineDays: z.number().int().min(1).max(30).optional().describe('Días de plazo para retirarlo (default 5); solo con arrived'),
      customerName: z.string().trim().min(1).max(60).optional().describe('Nombre del cliente, si lo dijo en la conversación'),
    }),
    callback: async ({ hopPointId, arrived, deadlineDays, customerName }) => {
      const hopPoints = await deps.repos.listHopPoints();
      if (hopPoints.length === 0) return { created: false, reason: 'No hay Puntos HOP cargados' };

      const hop = hopPointId ? hopPoints.find((h) => h.id === hopPointId) : hopPoints[0];
      if (!hop) {
        return { created: false, reason: `No existe el Punto HOP "${hopPointId}"`, available: hopPoints.map((h) => h.id) };
      }

      const days = deadlineDays ?? DEFAULT_DEADLINE_DAYS;
      const createdAt = now();
      // El remitente arranca en camino; el destinatario ya lo tiene esperando en el punto.
      const status: PackageStatus = arrived ? 'READY_AT_HOP' : 'IN_TRANSIT';

      // Tracking al azar en vez de "el mayor + 1": evita escanear la tabla entera en cada alta y
      // la carrera entre dos personas creando a la vez. La colisión la corta la condición del put.
      for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
        const pkg: Package = {
          trackingId: randomTrackingId(),
          phone: deps.phone,
          customerName: customerName ?? 'Cliente',
          status,
          hopPointId: hop.id,
          ...(status === 'READY_AT_HOP' ? { deadlineAt: endOfDayInBuenosAires(createdAt, days).toISOString() } : {}),
          updatedAt: createdAt.toISOString(),
        };
        try {
          await deps.repos.createPackage(pkg);
          return { created: true, package: presentPackage(pkg, createdAt), hopPoint: presentHopPoint(hop) };
        } catch (err) {
          if (err instanceof TrackingIdTakenError) continue;
          throw err;
        }
      }
      return { created: false, reason: 'No se pudo asignar un número de seguimiento libre, probá de nuevo' };
    },
  });

  /**
   * El remitente avisa que dejó el paquete en el Punto HOP: pasa a listo para retirar y arranca
   * el plazo. Solo sobre paquetes del cliente y que estén en camino.
   */
  const confirmDropoff = tool({
    name: 'confirm_dropoff',
    description:
      'Marca que el cliente ya dejó su paquete en el Punto HOP, así queda listo para retirar y empieza a correr el plazo. ' +
      'Usalo solo cuando confirma que lo dejó, sobre un paquete suyo que esté en camino.',
    inputSchema: z.object({
      trackingId: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{3,64}$/, 'Formato de tracking inválido')
        .describe('Número de seguimiento del paquete'),
      deadlineDays: z.number().int().min(1).max(30).optional().describe('Días de plazo para retirarlo (default 5)'),
    }),
    callback: async ({ trackingId, deadlineDays }) => {
      const pkg = await deps.repos.getPackage(trackingId.toUpperCase());
      if (!pkg || pkg.phone !== deps.phone) return { ok: false, reason: 'No encontré ese paquete' };
      if (pkg.status !== 'IN_TRANSIT') {
        return { ok: false, reason: `El paquete está ${pkg.status}, no en camino`, status: pkg.status };
      }
      if (!pkg.hopPointId) return { ok: false, reason: 'El paquete no tiene Punto HOP asignado' };

      const at = now();
      const updated = await deps.repos.updatePackageStatus(
        pkg.trackingId,
        {
          status: 'READY_AT_HOP',
          hopPointId: pkg.hopPointId,
          deadlineAt: endOfDayInBuenosAires(at, deadlineDays ?? DEFAULT_DEADLINE_DAYS).toISOString(),
          resetReadyNotification: true,
        },
        at,
      );
      const hop = await deps.repos.getHopPoint(pkg.hopPointId);
      return { ok: true, package: presentPackage(updated, at), ...(hop ? { hopPoint: presentHopPoint(hop) } : {}) };
    },
  });

  return [getMyPackages, getPackageByTracking, getHopPoint, listHopPoints, getCalendar, sendPackage, confirmDropoff];
}
