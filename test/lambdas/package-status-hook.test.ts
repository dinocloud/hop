import type { APIGatewayProxyEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcurrentUpdateError, type Repos } from '../../src/lib/dynamo.js';
import type { HopPoint, Package } from '../../src/lib/types.js';
import type { WhatsAppSender } from '../../src/lib/whatsapp.js';
import {
  METRIC_TEMPLATE_SEND_FAILED,
  METRIC_TEMPLATE_SENT,
  createHandler,
  type HookMetrics,
} from '../../src/lambdas/package-status-hook/handler.js';

const NOW = new Date('2026-10-17T12:00:00Z');
/** Fin del día 22/10 en Buenos Aires (5 días después del 17/10). */
const DEADLINE_5D = '2026-10-23T02:59:59.000Z';

const palermo: HopPoint = {
  id: 'hop-palermo',
  name: 'Punto HOP Palermo',
  address: 'Av. Santa Fe 3253, CABA',
  lat: -34.5885,
  lng: -58.4106,
  openingHours: 'Lun a Vie 9 a 20',
};

function pkg(overrides: Partial<Package> = {}): Package {
  return {
    trackingId: 'HOP-0001',
    phone: '+5491112345678',
    customerName: 'Ana',
    status: 'IN_TRANSIT',
    updatedAt: '2026-10-17T10:00:00Z',
    ...overrides,
  };
}

function event(trackingId: string | undefined, body: unknown): APIGatewayProxyEvent {
  return {
    pathParameters: trackingId === undefined ? null : { trackingId },
    body: body === null ? null : typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

function setup(current: Package | null = pkg()) {
  const repos = {
    getPackage: vi.fn(async () => current ?? undefined),
    getHopPoint: vi.fn(async (id: string) => (id === 'hop-palermo' ? palermo : undefined)),
    updatePackageStatus: vi.fn(async (trackingId: string, patch: Record<string, unknown>) =>
      pkg({ ...current, trackingId, ...(patch as Partial<Package>) }),
    ),
    markReadyNotification: vi.fn(async () => undefined),
  } as unknown as Repos;
  const sender = { sendTemplate: vi.fn(async () => ({ messageId: 'wamid.1' })) } as unknown as WhatsAppSender;
  const metrics: HookMetrics = { addMetric: vi.fn(), publishStoredMetrics: vi.fn() };
  const handler = createHandler({ repos, sender, templateName: 'paquete_listo', metrics, now: () => NOW });
  return { repos, sender, metrics, handler };
}

const parse = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;
const ready = { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineDays: 5 };

describe('package-status-hook', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('READY_AT_HOP: valida el punto, persiste el plazo a fin de día en BA, manda la plantilla y lo registra', async () => {
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ trackingId: 'HOP-0001', status: 'READY_AT_HOP', notified: true, messageId: 'wamid.1' });
    expect(ctx.repos.updatePackageStatus).toHaveBeenCalledWith(
      'HOP-0001',
      { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineAt: DEADLINE_5D, resetReadyNotification: true },
      NOW,
      { expectedUpdatedAt: '2026-10-17T10:00:00Z' },
    );
    expect(ctx.sender.sendTemplate).toHaveBeenCalledWith('+5491112345678', 'paquete_listo', ['Ana', 'Punto HOP Palermo', '5']);
    expect(ctx.repos.markReadyNotification).toHaveBeenCalledWith('HOP-0001', { status: 'SENT', messageId: 'wamid.1' }, NOW);
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith(METRIC_TEMPLATE_SENT, 'Count', 1);
    expect(ctx.metrics.publishStoredMetrics).toHaveBeenCalledTimes(1);
  });

  it('READY_AT_HOP repetido con aviso ya enviado: no reenvía, no escribe y no corre el plazo', async () => {
    ctx = setup(
      pkg({
        status: 'READY_AT_HOP',
        hopPointId: 'hop-palermo',
        deadlineAt: DEADLINE_5D,
        readyNotificationStatus: 'SENT',
        readyMessageId: 'wamid.old',
        readyNotifiedAt: '2026-10-17T10:00:01Z',
      }),
    );
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ trackingId: 'HOP-0001', status: 'READY_AT_HOP', notified: true, duplicate: true, messageId: 'wamid.old' });
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
    expect(ctx.sender.sendTemplate).not.toHaveBeenCalled();
  });

  it('READY_AT_HOP repetido con aviso fallido: reintenta el envío conservando el plazo original', async () => {
    ctx = setup(pkg({ status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineAt: '2026-10-20T02:59:59.000Z', readyNotificationStatus: 'FAILED' }));
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(202);
    expect(parse(res).notified).toBe(true);
    expect(ctx.repos.updatePackageStatus).toHaveBeenCalledWith(
      'HOP-0001',
      { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineAt: '2026-10-20T02:59:59.000Z', resetReadyNotification: false },
      NOW,
      { expectedUpdatedAt: '2026-10-17T10:00:00Z' },
    );
    expect(ctx.sender.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('READY_AT_HOP en otro punto: nuevo plazo y nuevo aviso', async () => {
    ctx = setup(pkg({ status: 'READY_AT_HOP', hopPointId: 'hop-caballito', readyNotificationStatus: 'SENT' }));
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(202);
    expect(ctx.repos.updatePackageStatus).toHaveBeenCalledWith(
      'HOP-0001',
      expect.objectContaining({ hopPointId: 'hop-palermo', deadlineAt: DEADLINE_5D, resetReadyNotification: true }),
      NOW,
      expect.anything(),
    );
    expect(ctx.sender.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('si la plantilla falla de forma permanente: 202 notified=false, se registra FAILED y la métrica', async () => {
    vi.mocked(ctx.sender.sendTemplate).mockRejectedValueOnce(Object.assign(new Error('Template name does not exist'), { name: 'ValidationException' }));
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ trackingId: 'HOP-0001', status: 'READY_AT_HOP', notified: false });
    expect(ctx.repos.markReadyNotification).toHaveBeenCalledWith('HOP-0001', { status: 'FAILED', error: 'ValidationException' }, NOW);
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith(METRIC_TEMPLATE_SEND_FAILED, 'Count', 1);
  });

  it('si la plantilla falla de forma transitoria: 503 para que reintenten, sin marcar SENT', async () => {
    vi.mocked(ctx.sender.sendTemplate).mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(503);
    expect(parse(res).notified).toBe(false);
    expect(ctx.repos.markReadyNotification).not.toHaveBeenCalled();
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith(METRIC_TEMPLATE_SEND_FAILED, 'Count', 1);
  });

  it('otros estados: persiste sin plazo, limpia el aviso y no envía nada', async () => {
    const res = await ctx.handler(event('HOP-0002', { status: 'DELIVERED' }));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ trackingId: 'HOP-0002', status: 'DELIVERED', notified: false });
    expect(ctx.repos.updatePackageStatus).toHaveBeenCalledWith(
      'HOP-0002',
      { status: 'DELIVERED', resetReadyNotification: true },
      NOW,
      { expectedUpdatedAt: '2026-10-17T10:00:00Z' },
    );
    expect(ctx.repos.getHopPoint).not.toHaveBeenCalled();
    expect(ctx.sender.sendTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ['DELIVERED → READY_AT_HOP', 'DELIVERED', ready],
    ['RETURNED → IN_TRANSIT', 'RETURNED', { status: 'IN_TRANSIT' }],
  ])('409 en transición no permitida: %s', async (_name, from, body) => {
    ctx = setup(pkg({ status: from as Package['status'] }));
    const res = await ctx.handler(event('HOP-0001', body));
    expect(res.statusCode).toBe(409);
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
    expect(ctx.sender.sendTemplate).not.toHaveBeenCalled();
  });

  it('409 si el paquete cambió entre la lectura y la escritura', async () => {
    vi.mocked(ctx.repos.updatePackageStatus).mockRejectedValueOnce(new ConcurrentUpdateError('HOP-0001'));
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(409);
    expect(ctx.sender.sendTemplate).not.toHaveBeenCalled();
  });

  it('404 si el paquete no existe, sin escribir ni enviar', async () => {
    ctx = setup(null);
    const res = await ctx.handler(event('NOPE-1', { status: 'IN_TRANSIT' }));
    expect(res.statusCode).toBe(404);
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
    expect(ctx.sender.sendTemplate).not.toHaveBeenCalled();
  });

  it('400 si el Punto HOP no existe, sin escribir', async () => {
    const res = await ctx.handler(event('HOP-0001', { ...ready, hopPointId: 'hop-nope' }));
    expect(res.statusCode).toBe(400);
    expect(parse(res).error).toMatch(/hop-nope/);
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['READY_AT_HOP sin hopPointId ni deadlineDays', { status: 'READY_AT_HOP' }],
    ['DELIVERED con deadlineDays', { status: 'DELIVERED', deadlineDays: 5 }],
    ['IN_TRANSIT con hopPointId', { status: 'IN_TRANSIT', hopPointId: 'hop-palermo' }],
    ['estado desconocido', { status: 'LOST' }],
    ['deadlineDays fuera de rango', { ...ready, deadlineDays: 31 }],
    ['campo extra', { status: 'DELIVERED', foo: 1 }],
    ['JSON roto', '{status:'],
    ['body null (API Gateway sin body)', null],
  ])('400 con body inválido: %s', async (_name, body) => {
    const res = await ctx.handler(event('HOP-0001', body));
    expect(res.statusCode).toBe(400);
    expect(ctx.repos.getPackage).not.toHaveBeenCalled();
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
  });

  it('400 con trackingId inválido o ausente', async () => {
    expect((await ctx.handler(event('a b', { status: 'DELIVERED' }))).statusCode).toBe(400);
    expect((await ctx.handler(event(undefined, { status: 'DELIVERED' }))).statusCode).toBe(400);
  });

  it('500 genérico ante errores inesperados, sin filtrar detalles ni enviar', async () => {
    vi.mocked(ctx.repos.getHopPoint).mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    const res = await ctx.handler(event('HOP-0001', ready));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('ProvisionedThroughput');
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
    expect(ctx.sender.sendTemplate).not.toHaveBeenCalled();
    expect(ctx.metrics.publishStoredMetrics).toHaveBeenCalledTimes(1);
  });
});
