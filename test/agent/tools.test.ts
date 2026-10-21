import { describe, expect, it, vi } from 'vitest';
import { createTools } from '../../agent/src/tools.js';
import type { Repos } from '../../src/lib/dynamo.js';
import type { HopPoint, Package } from '../../src/lib/types.js';

const PHONE = '+5491112345678';
const OTHER = '+5491187654321';
/** Sábado 17/10, 09:00 en Buenos Aires. */
const NOW = new Date('2026-10-17T12:00:00Z');

const palermo: HopPoint = {
  id: 'hop-palermo',
  name: 'Punto HOP Palermo',
  address: 'Av. Santa Fe 3253, CABA',
  lat: -34.5885,
  lng: -58.4106,
  openingHours: 'Lun a Vie 9 a 20',
};

const mine: Package = {
  trackingId: 'HOP-0001',
  phone: PHONE,
  customerName: 'Ana',
  status: 'READY_AT_HOP',
  hopPointId: 'hop-palermo',
  deadlineAt: '2026-10-23T02:59:59.000Z',
  readyNotificationStatus: 'SENT',
  readyMessageId: 'wamid.1',
  updatedAt: '2026-10-17T12:00:00Z',
};
const theirs: Package = { ...mine, trackingId: 'HOP-0002', phone: OTHER };

function setup() {
  const repos = {
    getPackagesByPhone: vi.fn(async (phone: string, limit: number) => (phone === PHONE ? [mine].slice(0, limit) : [])),
    getPackage: vi.fn(async (id: string) => ({ 'HOP-0001': mine, 'HOP-0002': theirs })[id]),
    getHopPoint: vi.fn(async (id: string) => (id === 'hop-palermo' ? palermo : undefined)),
  } as unknown as Repos;
  const tools = createTools({ repos, phone: PHONE, now: () => NOW });
  type AnyTool = { invoke(input: unknown): Promise<unknown> };
  const byName: Record<string, AnyTool> = Object.fromEntries(tools.map((t) => [t.name, t as unknown as AnyTool]));
  return { repos, byName };
}

describe('tools del agente', () => {
  it('expone exactamente las tres tools de consulta', () => {
    const { byName } = setup();
    expect(Object.keys(byName).sort()).toEqual(['get_hop_point', 'get_my_packages', 'get_package_by_tracking']);
  });

  it('get_my_packages usa el teléfono de la sesión y no expone el teléfono ni datos internos', async () => {
    const { repos, byName } = setup();
    const res = (await byName['get_my_packages']!.invoke({ limit: 5 })) as { packages: Record<string, unknown>[] };
    expect(repos.getPackagesByPhone).toHaveBeenCalledWith(PHONE, 5);
    expect(res.packages).toHaveLength(1);
    expect(res.packages[0]).toEqual({
      trackingId: 'HOP-0001',
      customerName: 'Ana',
      status: 'READY_AT_HOP',
      hopPointId: 'hop-palermo',
      deadlineLocal: 'jueves 22 de octubre',
      daysLeft: 5,
      scheduledLocal: null,
      updatedAt: '2026-10-17T12:00:00Z',
    });
    expect(JSON.stringify(res)).not.toContain('5678');
    expect(JSON.stringify(res)).not.toContain('wamid');
  });

  it('las fechas llegan al modelo ya escritas en hora de Buenos Aires, sin el ISO en UTC que corre el día', async () => {
    const { byName } = setup();
    const res = await byName['get_package_by_tracking']!.invoke({ trackingId: 'HOP-0001' });
    expect(res).toMatchObject({ found: true, package: { deadlineLocal: 'jueves 22 de octubre', daysLeft: 5 } });
    expect(JSON.stringify(res)).not.toContain('T02:59:59');
  });

  it('get_package_by_tracking solo devuelve paquetes del cliente de la sesión', async () => {
    const { byName } = setup();
    expect(await byName['get_package_by_tracking']!.invoke({ trackingId: 'hop-0001' })).toMatchObject({ found: true });
    expect(await byName['get_package_by_tracking']!.invoke({ trackingId: 'HOP-0002' })).toEqual({ found: false });
    expect(await byName['get_package_by_tracking']!.invoke({ trackingId: 'HOP-9999' })).toEqual({ found: false });
  });

  it('get_package_by_tracking rechaza formatos inválidos antes de tocar la base', async () => {
    const { repos, byName } = setup();
    await expect(byName['get_package_by_tracking']!.invoke({ trackingId: 'HOP 0001; DROP' })).rejects.toThrow();
    expect(repos.getPackage).not.toHaveBeenCalled();
  });

  it('get_hop_point devuelve ubicación y horarios', async () => {
    const { byName } = setup();
    expect(await byName['get_hop_point']!.invoke({ hopPointId: 'hop-palermo' })).toEqual({
      found: true,
      hopPoint: { id: 'hop-palermo', name: 'Punto HOP Palermo', address: 'Av. Santa Fe 3253, CABA', lat: -34.5885, lng: -58.4106, openingHours: 'Lun a Vie 9 a 20' },
    });
    expect(await byName['get_hop_point']!.invoke({ hopPointId: 'hop-nope' })).toEqual({ found: false });
  });
});
