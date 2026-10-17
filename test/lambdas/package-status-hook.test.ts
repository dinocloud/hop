import type { APIGatewayProxyEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PackageNotFoundError, type Repos } from '../../src/lib/dynamo.js';
import type { HopPoint, Package } from '../../src/lib/types.js';
import type { WhatsAppSender } from '../../src/lib/whatsapp.js';
import { createHandler } from '../../src/lambdas/package-status-hook/handler.js';

const NOW = new Date('2026-10-17T12:00:00Z');

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
    body: typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

function setup() {
  const repos = {
    getHopPoint: vi.fn(async (id: string) => (id === 'hop-palermo' ? palermo : undefined)),
    updatePackageStatus: vi.fn(async (trackingId: string, patch) => pkg({ trackingId, ...patch })),
  } as unknown as Repos;
  const sender = {
    sendTemplate: vi.fn(async () => ({ messageId: 'wamid.1' })),
    sendText: vi.fn(),
    sendLocation: vi.fn(),
  } as unknown as WhatsAppSender;
  const handler = createHandler({ repos, sender, templateName: 'paquete_listo', now: () => NOW });
  return { repos, sender, handler };
}

const parse = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

describe('package-status-hook', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('READY_AT_HOP: valida el punto, persiste el plazo y manda la plantilla', async () => {
    const res = await ctx.handler(event('HOP-0001', { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineDays: 5 }));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ trackingId: 'HOP-0001', status: 'READY_AT_HOP', notified: true, messageId: 'wamid.1' });
    expect(ctx.repos.updatePackageStatus).toHaveBeenCalledWith(
      'HOP-0001',
      { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineAt: '2026-10-22T12:00:00.000Z' },
      NOW,
    );
    expect(ctx.sender.sendTemplate).toHaveBeenCalledWith('+5491112345678', 'paquete_listo', ['Ana', 'Punto HOP Palermo', '5']);
  });

  it('si la plantilla falla, el estado igual queda guardado y notified=false', async () => {
    vi.mocked(ctx.sender.sendTemplate).mockRejectedValueOnce(new Error('Template name does not exist'));
    const res = await ctx.handler(event('HOP-0001', { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineDays: 2 }));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ trackingId: 'HOP-0001', status: 'READY_AT_HOP', notified: false });
    expect(ctx.repos.updatePackageStatus).toHaveBeenCalledTimes(1);
  });

  it('otros estados: persiste sin plazo y no envía nada', async () => {
    const res = await ctx.handler(event('HOP-0002', { status: 'DELIVERED' }));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ trackingId: 'HOP-0002', status: 'DELIVERED', notified: false });
    expect(ctx.repos.updatePackageStatus).toHaveBeenCalledWith(
      'HOP-0002',
      { status: 'DELIVERED', hopPointId: undefined, deadlineAt: undefined },
      NOW,
    );
    expect(ctx.repos.getHopPoint).not.toHaveBeenCalled();
    expect(ctx.sender.sendTemplate).not.toHaveBeenCalled();
  });

  it('404 si el paquete no existe', async () => {
    vi.mocked(ctx.repos.updatePackageStatus).mockRejectedValueOnce(new PackageNotFoundError('NOPE-1'));
    const res = await ctx.handler(event('NOPE-1', { status: 'IN_TRANSIT' }));
    expect(res.statusCode).toBe(404);
  });

  it('400 si el Punto HOP no existe, sin escribir', async () => {
    const res = await ctx.handler(event('HOP-0001', { status: 'READY_AT_HOP', hopPointId: 'hop-nope', deadlineDays: 5 }));
    expect(res.statusCode).toBe(400);
    expect(parse(res).error).toMatch(/hop-nope/);
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['READY_AT_HOP sin hopPointId ni deadlineDays', { status: 'READY_AT_HOP' }],
    ['estado desconocido', { status: 'LOST' }],
    ['deadlineDays fuera de rango', { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineDays: 31 }],
    ['campo extra', { status: 'DELIVERED', foo: 1 }],
    ['JSON roto', '{status:'],
    ['sin body', null],
  ])('400 con body inválido: %s', async (_name, body) => {
    const res = await ctx.handler(event('HOP-0001', body));
    expect(res.statusCode).toBe(400);
    expect(ctx.repos.updatePackageStatus).not.toHaveBeenCalled();
  });

  it('400 con trackingId inválido o ausente', async () => {
    expect((await ctx.handler(event('a b', { status: 'DELIVERED' }))).statusCode).toBe(400);
    expect((await ctx.handler(event(undefined, { status: 'DELIVERED' }))).statusCode).toBe(400);
  });

  it('500 genérico ante errores inesperados, sin filtrar detalles', async () => {
    vi.mocked(ctx.repos.updatePackageStatus).mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    const res = await ctx.handler(event('HOP-0001', { status: 'DELIVERED' }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('ProvisionedThroughput');
  });
});
