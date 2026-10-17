import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { z } from 'zod';
import { PackageNotFoundError, createRepos, type Repos } from '../../lib/dynamo.js';
import { logger, maskPhone } from '../../lib/logger.js';
import { PACKAGE_STATUSES, requireEnv } from '../../lib/types.js';
import { createWhatsAppSender, type WhatsAppSender } from '../../lib/whatsapp.js';

/**
 * Hook de estado del paquete: `POST /packages/{trackingId}/status`.
 *
 * El sistema de envíos avisa el cambio de estado. Se persiste en DynamoDB y, si el paquete
 * quedó listo en un Punto HOP, se le manda al cliente la plantilla "paquete listo".
 * Reemplaza las campañas por CSV que hoy pasan por un middleware.
 *
 * Respuestas:
 * - 202 `{ trackingId, status, notified, messageId? }`: el estado quedó guardado. `notified`
 *   indica si la plantilla salió; si el envío falla el estado igual persiste (no se pierde).
 * - 400 body o path inválidos (API Gateway ya valida el modelo; acá se vuelve a validar).
 * - 404 el paquete no existe.
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
    }
  });

export type StatusBody = z.infer<typeof BodySchema>;

export interface HookDeps {
  repos: Repos;
  sender: WhatsAppSender;
  templateName: string;
  now?: () => Date;
}

export function createHandler(deps: HookDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handler(event: APIGatewayProxyEvent, context?: Context): Promise<APIGatewayProxyResult> {
    if (context) logger.addContext(context);

    const trackingId = event.pathParameters?.trackingId ?? '';
    if (!TRACKING_ID.test(trackingId)) return json(400, { error: 'trackingId inválido' });
    logger.appendKeys({ trackingId });

    const parsed = BodySchema.safeParse(parseJson(event.body));
    if (!parsed.success) {
      return json(400, { error: 'Body inválido', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const body = parsed.data;

    try {
      // Validar el Punto HOP antes de escribir, para no persistir un id que no existe.
      const hopPoint = body.status === 'READY_AT_HOP' ? await deps.repos.getHopPoint(body.hopPointId!) : undefined;
      if (body.status === 'READY_AT_HOP' && !hopPoint) {
        return json(400, { error: `Punto HOP desconocido: ${body.hopPointId}` });
      }

      const current = now();
      const pkg = await deps.repos.updatePackageStatus(
        trackingId,
        {
          status: body.status,
          hopPointId: body.hopPointId,
          deadlineAt: body.deadlineDays !== undefined ? addDays(current, body.deadlineDays).toISOString() : undefined,
        },
        current,
      );
      logger.info('Estado actualizado', { status: pkg.status, hopPointId: pkg.hopPointId, phone: maskPhone(pkg.phone) });

      if (body.status !== 'READY_AT_HOP' || !hopPoint) {
        return json(202, { trackingId, status: pkg.status, notified: false });
      }

      try {
        const { messageId } = await deps.sender.sendTemplate(pkg.phone, deps.templateName, [
          pkg.customerName,
          hopPoint.name,
          String(body.deadlineDays),
        ]);
        logger.info('Plantilla enviada', { template: deps.templateName, messageId });
        return json(202, { trackingId, status: pkg.status, notified: true, messageId });
      } catch (err) {
        // El estado ya quedó guardado; el aviso se puede reintentar desde el sistema de envíos.
        logger.error('No se pudo enviar la plantilla', { error: errorInfo(err), template: deps.templateName });
        return json(202, { trackingId, status: pkg.status, notified: false });
      }
    } catch (err) {
      if (err instanceof PackageNotFoundError) return json(404, { error: `No existe el paquete ${trackingId}` });
      logger.error('Error inesperado en el hook', { error: errorInfo(err) });
      return json(500, { error: 'Error interno' });
    }
  };
}

// Instancia perezosa para la Lambda real (los tests usan createHandler con mocks).
let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  if (!cached) {
    const repos = createRepos();
    cached = createHandler({
      repos,
      sender: createWhatsAppSender({ getConversation: repos.getConversation }),
      templateName: requireEnv('TEMPLATE_NAME'),
    });
  }
  return cached(event, context);
};

function parseJson(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function json(statusCode: number, payload: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

function errorInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'UnknownError', message: String(err) };
}
