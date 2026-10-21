import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { z } from 'zod';
import { errorInfo, errorName, isAmbiguousSendError, isTransientAwsError } from '../../lib/aws-errors.js';
import { ConcurrentUpdateError, PackageNotFoundError, createRepos, type Repos } from '../../lib/dynamo.js';
import { logger, maskPhone } from '../../lib/logger.js';
import { endOfDayInBuenosAires } from '../../lib/time.js';
import { PACKAGE_STATUSES, canTransition, isTerminalStatus, requireEnv, type Package } from '../../lib/types.js';
import { createWhatsAppSender, type WhatsAppSender } from '../../lib/whatsapp.js';

/**
 * Hook de estado del paquete: `POST /packages/{trackingId}/status`.
 *
 * El sistema de envíos avisa el cambio de estado. Se persiste en DynamoDB y, si el paquete
 * quedó listo en un Punto HOP, se le manda al cliente la plantilla "paquete listo".
 * Reemplaza las campañas por CSV que hoy pasan por un middleware.
 *
 * Garantías:
 * - Idempotente: el mismo `READY_AT_HOP` repetido no reenvía la plantilla ni corre el plazo, y un
 *   estado terminal repetido (webhook reintentado) no es un error.
 * - Transiciones controladas: `DELIVERED` y `RETURNED` son terminales (422 si se intenta salir).
 * - Sin updates perdidos: la escritura exige que el paquete no haya cambiado desde la lectura (409 si cambió).
 * - El plazo guardado coincide siempre con los días que dice el aviso.
 * - El aviso queda registrado en el paquete (`readyNotificationStatus`) y, si falla de forma permanente, en una métrica.
 *
 * Respuestas:
 * - 202 `{ trackingId, status, notified, messageId?, duplicate? }`: el estado quedó guardado.
 * - 400 body, path o Punto HOP inválidos. 404 el paquete no existe. 409 el paquete cambió durante el
 *   procesamiento (reintentar). 422 transición no permitida (no reintentar).
 * - 503 el envío falló por una causa transitoria (throttling, 5xx): el estado quedó guardado y el
 *   sistema de envíos puede reintentar. Un timeout del envío es ambiguo (el mensaje pudo salir):
 *   responde 202 `notified: false` sin pedir reintento, para no duplicar el aviso.
 */

const TRACKING_ID = /^[A-Za-z0-9-]{3,64}$/;

export const BodySchema = z
  .object({
    status: z.enum(PACKAGE_STATUSES),
    hopPointId: z.string().min(1).max(64).optional(),
    deadlineDays: z.number().int().min(1).max(30).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.status === 'READY_AT_HOP') {
      if (!body.hopPointId) ctx.addIssue({ code: 'custom', path: ['hopPointId'], message: 'Obligatorio para READY_AT_HOP' });
      if (body.deadlineDays === undefined)
        ctx.addIssue({ code: 'custom', path: ['deadlineDays'], message: 'Obligatorio para READY_AT_HOP' });
    } else {
      if (body.hopPointId !== undefined)
        ctx.addIssue({ code: 'custom', path: ['hopPointId'], message: 'Solo se acepta con READY_AT_HOP' });
      if (body.deadlineDays !== undefined)
        ctx.addIssue({ code: 'custom', path: ['deadlineDays'], message: 'Solo se acepta con READY_AT_HOP' });
    }
  });

export type StatusBody = z.infer<typeof BodySchema>;

export interface HookMetrics {
  addMetric(name: string, unit: (typeof MetricUnit)[keyof typeof MetricUnit], value: number): void;
  publishStoredMetrics(): void;
}

export interface HookDeps {
  repos: Pick<Repos, 'getPackage' | 'getHopPoint' | 'updatePackageStatus' | 'markReadyNotification'>;
  sender: Pick<WhatsAppSender, 'sendTemplate'>;
  templateName: string;
  metrics?: HookMetrics;
  now?: () => Date;
}

export const METRIC_TEMPLATE_SEND_FAILED = 'TemplateSendFailed';
export const METRIC_TEMPLATE_SENT = 'TemplateSent';

export function createHandler(deps: HookDeps) {
  const now = deps.now ?? (() => new Date());
  const metrics = deps.metrics ?? noopMetrics;

  return async function handler(event: APIGatewayProxyEvent, context?: Context): Promise<APIGatewayProxyResult> {
    if (context) logger.addContext(context);
    try {
      return await handle(event);
    } finally {
      metrics.publishStoredMetrics();
    }
  };

  async function handle(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    // Los trackings se guardan y buscan siempre en mayúsculas.
    const trackingId = (event.pathParameters?.trackingId ?? '').toUpperCase();
    if (!TRACKING_ID.test(trackingId)) {
      logger.warn('trackingId inválido', { length: trackingId.length });
      return json(400, { error: 'trackingId inválido' });
    }
    logger.appendKeys({ trackingId });

    const parsed = BodySchema.safeParse(parseJson(event.body));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
      logger.warn('Body inválido', { issues });
      return json(400, { error: 'Body inválido', issues });
    }
    const body = parsed.data;

    try {
      const current = await deps.repos.getPackage(trackingId);
      if (!current) return json(404, { error: `No existe el paquete ${trackingId}` });

      if (current.status === body.status && isTerminalStatus(current.status)) {
        logger.info('Estado terminal repetido, sin cambios', { status: current.status });
        return json(202, { trackingId, status: current.status, notified: false, duplicate: true });
      }

      if (!canTransition(current.status, body.status)) {
        logger.warn('Transición de estado no permitida', { from: current.status, to: body.status });
        return json(422, { error: 'Transición de estado no permitida', from: current.status, to: body.status });
      }

      if (body.status !== 'READY_AT_HOP') {
        const pkg = await deps.repos.updatePackageStatus(
          trackingId,
          { status: body.status, resetReadyNotification: true },
          now(),
          { expectedUpdatedAt: current.updatedAt },
        );
        logger.info('Estado actualizado', { status: pkg.status, phone: maskPhone(pkg.phone) });
        return json(202, { trackingId, status: pkg.status, notified: false });
      }

      // READY_AT_HOP: validar el Punto HOP antes de escribir, para no persistir un id que no existe.
      const hopPointId = body.hopPointId!;
      const hopPoint = await deps.repos.getHopPoint(hopPointId);
      if (!hopPoint) return json(400, { error: `Punto HOP desconocido: ${hopPointId}` });

      const sameReady = current.status === 'READY_AT_HOP' && current.hopPointId === hopPointId;
      if (sameReady && current.readyNotificationStatus === 'SENT') {
        // Mismo aviso repetido: no se reenvía la plantilla ni se corre el plazo.
        logger.info('READY_AT_HOP repetido, aviso ya enviado', { readyNotifiedAt: current.readyNotifiedAt });
        return json(202, {
          trackingId,
          status: current.status,
          notified: true,
          duplicate: true,
          messageId: current.readyMessageId,
        });
      }

      const at = now();
      const pkg = await deps.repos.updatePackageStatus(
        trackingId,
        {
          status: 'READY_AT_HOP',
          hopPointId,
          // Acá se llega solo si el aviso todavía no salió, así que el plazo se calcula de nuevo para
          // que coincida con los días que va a decir la plantilla.
          deadlineAt: endOfDayInBuenosAires(at, body.deadlineDays!).toISOString(),
          resetReadyNotification: !sameReady,
        },
        at,
        { expectedUpdatedAt: current.updatedAt },
      );
      logger.info('Estado actualizado', { status: pkg.status, hopPointId: pkg.hopPointId, phone: maskPhone(pkg.phone) });

      return await notifyReady(pkg, hopPoint.name, body.deadlineDays!, at);
    } catch (err) {
      if (err instanceof PackageNotFoundError) return json(404, { error: `No existe el paquete ${trackingId}` });
      if (err instanceof ConcurrentUpdateError) {
        logger.warn('El paquete cambió durante el procesamiento', { trackingId });
        return json(409, { error: 'El paquete cambió durante el procesamiento, reintentar' });
      }
      logger.error('Error inesperado en el hook', { error: errorInfo(err) });
      return json(500, { error: 'Error interno' });
    }
  }

  async function notifyReady(pkg: Package, hopPointName: string, deadlineDays: number, at: Date): Promise<APIGatewayProxyResult> {
    let messageId: string | undefined;
    try {
      ({ messageId } = await deps.sender.sendTemplate(pkg.phone, deps.templateName, [
        pkg.customerName,
        hopPointName,
        String(deadlineDays),
      ]));
    } catch (err) {
      return onSendFailed(pkg, err, at);
    }
    metrics.addMetric(METRIC_TEMPLATE_SENT, MetricUnit.Count, 1);
    logger.info('Plantilla enviada', { template: deps.templateName, messageId });

    try {
      await deps.repos.markReadyNotification(pkg.trackingId, { status: 'SENT', messageId }, at);
    } catch (err) {
      // La plantilla ya salió: no es un fallo de envío. Sin este registro, un READY_AT_HOP repetido la reenviaría.
      logger.error('La plantilla salió pero no se pudo registrar el aviso', { error: errorInfo(err), messageId });
    }
    return json(202, { trackingId: pkg.trackingId, status: pkg.status, notified: true, messageId });
  }

  async function onSendFailed(pkg: Package, err: unknown, at: Date): Promise<APIGatewayProxyResult> {
    const info = errorInfo(err);
    if (isAmbiguousSendError(err)) {
      // No se sabe si salió: pedir un reintento podría duplicar el aviso. Un READY_AT_HOP repetido a mano lo reenvía.
      logger.warn('Resultado del envío de la plantilla desconocido: no se pide reintento', { error: info, template: deps.templateName });
      return json(202, { trackingId: pkg.trackingId, status: pkg.status, notified: false });
    }
    if (isTransientAwsError(err)) {
      // El estado ya quedó guardado y el aviso no está marcado como SENT: el reintento lo vuelve a enviar.
      logger.warn('Envío de plantilla falló por causa transitoria', { error: info, template: deps.templateName });
      return json(503, {
        trackingId: pkg.trackingId,
        status: pkg.status,
        notified: false,
        error: 'Envío temporalmente no disponible, reintentar',
      });
    }
    metrics.addMetric(METRIC_TEMPLATE_SEND_FAILED, MetricUnit.Count, 1);
    logger.error('No se pudo enviar la plantilla', { error: info, template: deps.templateName });
    await deps.repos.markReadyNotification(pkg.trackingId, { status: 'FAILED', error: errorName(err) }, at).catch((e: unknown) => {
      logger.error('No se pudo registrar el fallo del aviso', { error: errorInfo(e) });
    });
    return json(202, { trackingId: pkg.trackingId, status: pkg.status, notified: false });
  }
}

// Instancia perezosa para la Lambda real (los tests usan createHandler con mocks).
let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  if (!cached) {
    const repos = createRepos();
    cached = createHandler({
      repos,
      sender: createWhatsAppSender({
        // El hook solo manda plantillas y no tiene permisos sobre Conversations.
        getConversation: async () => {
          throw new Error('El hook no puede enviar texto libre: solo plantillas');
        },
      }),
      templateName: requireEnv('TEMPLATE_NAME'),
      metrics: new Metrics({ namespace: 'HopHackathon', serviceName: 'package-status-hook' }),
    });
  }
  return cached(event, context);
};

const noopMetrics: HookMetrics = { addMetric: () => undefined, publishStoredMetrics: () => undefined };

function parseJson(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function json(statusCode: number, payload: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}
