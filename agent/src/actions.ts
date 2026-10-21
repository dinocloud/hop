import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { ConcurrentUpdateError, type PackageStatusPatch } from '../../src/lib/dynamo.js';
import { calendarDaysUntilInBuenosAires, endOfDayInBuenosAires, formatDayInBuenosAires, isoDateInBuenosAires } from '../../src/lib/time.js';
import { canTransition, type Package, type PackageStatus } from '../../src/lib/types.js';
import { presentHopPoint, presentPackage, type ToolDeps } from './tools.js';

/**
 * Tools de resolución del aviso "paquete listo": extender el plazo, cambiar de Punto HOP,
 * reprogramar la entrega y devolver al remitente. Escriben en `Packages`.
 *
 * Cada acción tiene dos pasos. Con `confirmed: false` valida y devuelve un preview de lo que va
 * a pasar, sin escribir. Con `confirmed: true` escribe, pero solo si ese mismo preview ya se
 * mostró en la sesión: el modelo no puede ejecutar un cambio que el cliente no vio. La escritura
 * exige que el paquete no haya cambiado desde la lectura (`expectedUpdatedAt`).
 */

export const MAX_EXTENSION_DAYS = 7;
export const MAX_RESCHEDULE_DAYS = 14;

const STATUS_LABELS: Record<PackageStatus, string> = {
  IN_TRANSIT: 'en camino',
  READY_AT_HOP: 'listo para retirar',
  DELIVERED: 'entregado',
  RETURNED: 'devuelto al remitente',
};

const NEXT_STEP = 'Contale esto al cliente en una línea y preguntale si confirma. Si dice que sí, volvé a llamar con confirmed: true.';

const trackingIdInput = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{3,64}$/, 'Formato de tracking inválido')
  .describe('Número de seguimiento del paquete');
const confirmedInput = z
  .boolean()
  .describe('false: devuelve qué va a pasar, sin cambiar nada. true: ejecuta, solo después de que el cliente confirmó ese mismo preview.');

interface ActionPlan {
  /** Lo que se le muestra al cliente antes de confirmar. */
  preview: Record<string, unknown>;
  patch: PackageStatusPatch;
  /** Datos extra para la respuesta después de ejecutar. */
  extra?: Record<string, unknown>;
}

type ActionResult = Record<string, unknown>;

export function createActionTools(deps: ToolDeps) {
  const now = deps.now ?? (() => new Date());
  /** Previews mostrados en esta sesión (el agente vive mientras vive la sesión de AgentCore). */
  const previews = new Set<string>();

  async function runAction(
    key: string,
    trackingId: string,
    confirmed: boolean,
    plan: (pkg: Package) => Promise<ActionPlan | string>,
  ): Promise<ActionResult> {
    const pkg = await deps.repos.getPackage(trackingId.toUpperCase());
    if (!pkg || pkg.phone !== deps.phone) return { ok: false, error: 'No encontré ese paquete entre los tuyos' };
    // El plan se arma de nuevo al confirmar: el paquete pudo cambiar desde el preview.
    const planned = await plan(pkg);
    if (typeof planned === 'string') return { ok: false, error: planned };

    const previewKey = `${key}:${pkg.trackingId}`;
    if (!confirmed) {
      previews.add(previewKey);
      return { ok: true, preview: true, ...planned.preview, next: NEXT_STEP };
    }
    if (!previews.has(previewKey)) {
      return { ok: false, error: 'Primero mostrale al cliente lo que va a pasar (confirmed: false) y esperá que confirme' };
    }
    try {
      const updated = await deps.repos.updatePackageStatus(pkg.trackingId, planned.patch, now(), { expectedUpdatedAt: pkg.updatedAt });
      previews.delete(previewKey);
      return { ok: true, package: presentPackage(updated, now()), ...planned.extra };
    } catch (err) {
      if (err instanceof ConcurrentUpdateError)
        return { ok: false, error: 'El paquete cambió mientras tanto: consultalo de nuevo antes de seguir' };
      throw err;
    }
  }

  function cannot(action: string, pkg: Package): string {
    return `No se puede ${action}: el paquete está ${STATUS_LABELS[pkg.status]}`;
  }

  const extendDeadline = tool({
    name: 'extend_deadline',
    description: `Extiende el plazo de retiro de un paquete listo para retirar, hasta ${MAX_EXTENSION_DAYS} días más. Primero con confirmed: false.`,
    inputSchema: z.object({
      trackingId: trackingIdInput,
      days: z.number().int().min(1).max(MAX_EXTENSION_DAYS).describe('Días a sumar al plazo actual'),
      confirmed: confirmedInput,
    }),
    callback: async ({ trackingId, days, confirmed }) =>
      runAction(`extend:${days}`, trackingId, confirmed, async (pkg) => {
        if (pkg.status !== 'READY_AT_HOP' || !pkg.deadlineAt)
          return 'Solo se puede extender el plazo de un paquete que está listo para retirar';
        const current = new Date(pkg.deadlineAt);
        const extended = endOfDayInBuenosAires(current, days);
        return {
          preview: {
            action: 'extend_deadline',
            trackingId: pkg.trackingId,
            days,
            currentDeadlineLocal: formatDayInBuenosAires(current),
            newDeadlineLocal: formatDayInBuenosAires(extended),
          },
          patch: { status: 'READY_AT_HOP', hopPointId: pkg.hopPointId, deadlineAt: extended.toISOString() },
        };
      }),
  });

  const changeHopPoint = tool({
    name: 'change_hop_point',
    description:
      'Cambia el Punto HOP de un paquete en camino o listo para retirar. El paquete queda en camino al punto nuevo y, cuando llega, se avisa de nuevo con plazo nuevo. Primero con confirmed: false.',
    inputSchema: z.object({
      trackingId: trackingIdInput,
      hopPointId: z.string().trim().min(1).max(64).describe('Id del Punto HOP nuevo, de list_hop_points'),
      confirmed: confirmedInput,
    }),
    callback: async ({ trackingId, hopPointId, confirmed }) =>
      runAction(`change:${hopPointId}`, trackingId, confirmed, async (pkg) => {
        if (!canTransition(pkg.status, 'IN_TRANSIT')) return cannot('cambiar el Punto HOP', pkg);
        if (pkg.hopPointId === hopPointId) return 'El paquete ya está asignado a ese Punto HOP';
        const target = await deps.repos.getHopPoint(hopPointId);
        if (!target) return 'No existe ese Punto HOP: usá list_hop_points para ver las opciones';
        return {
          preview: { action: 'change_hop_point', trackingId: pkg.trackingId, newHopPoint: presentHopPoint(target) },
          patch: { status: 'IN_TRANSIT', hopPointId, resetReadyNotification: true },
          extra: { hopPoint: presentHopPoint(target) },
        };
      }),
  });

  const rescheduleDelivery = tool({
    name: 'reschedule_delivery',
    description: `Reprograma la entrega de un paquete para otra fecha, entre mañana y dentro de ${MAX_RESCHEDULE_DAYS} días. Usá get_calendar para la fecha. El paquete queda en camino. Primero con confirmed: false.`,
    inputSchema: z.object({
      trackingId: trackingIdInput,
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido')
        .describe('Fecha nueva en formato YYYY-MM-DD, de get_calendar'),
      confirmed: confirmedInput,
    }),
    callback: async ({ trackingId, date, confirmed }) =>
      runAction(`reschedule:${date}`, trackingId, confirmed, async (pkg) => {
        if (!canTransition(pkg.status, 'IN_TRANSIT')) return cannot('reprogramar la entrega', pkg);
        // Mediodía en BA: la fecha queda en el día correcto aunque se lea en otra zona horaria.
        const scheduled = new Date(`${date}T12:00:00-03:00`);
        if (Number.isNaN(scheduled.getTime()) || isoDateInBuenosAires(scheduled) !== date) return `La fecha ${date} no existe`;
        const daysAhead = calendarDaysUntilInBuenosAires(scheduled, now());
        if (daysAhead < 1 || daysAhead > MAX_RESCHEDULE_DAYS)
          return `Se puede reprogramar entre mañana y dentro de ${MAX_RESCHEDULE_DAYS} días`;
        return {
          preview: { action: 'reschedule_delivery', trackingId: pkg.trackingId, scheduledLocal: formatDayInBuenosAires(scheduled) },
          patch: { status: 'IN_TRANSIT', scheduledAt: scheduled.toISOString(), resetReadyNotification: true },
        };
      }),
  });

  const requestReturn = tool({
    name: 'request_return',
    description: 'Devuelve un paquete en camino o listo para retirar al remitente. Es definitivo. Primero con confirmed: false.',
    inputSchema: z.object({ trackingId: trackingIdInput, confirmed: confirmedInput }),
    callback: async ({ trackingId, confirmed }) =>
      runAction('return', trackingId, confirmed, async (pkg) => {
        if (!canTransition(pkg.status, 'RETURNED')) return cannot('devolverlo', pkg);
        return {
          preview: {
            action: 'request_return',
            trackingId: pkg.trackingId,
            warning: 'Es definitivo: el paquete vuelve al remitente y ya no se puede retirar',
          },
          patch: { status: 'RETURNED', resetReadyNotification: true },
        };
      }),
  });

  return [extendDeadline, changeHopPoint, rescheduleDelivery, requestReturn];
}
