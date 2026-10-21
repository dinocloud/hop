import { describe, expect, it, vi } from 'vitest';
import { createActionTools } from '../../agent/src/actions.js';
import { ConcurrentUpdateError, type Repos } from '../../src/lib/dynamo.js';
import type { HopPoint, Package } from '../../src/lib/types.js';

const PHONE = '+5491112345678';
const OTHER = '+5491187654321';
/** Miércoles 21/10, 12:00 en Buenos Aires. */
const NOW = new Date('2026-10-21T15:00:00Z');

const palermo: HopPoint = {
  id: 'hop-palermo',
  name: 'Punto HOP Palermo',
  address: 'Av. Santa Fe 3253, CABA',
  lat: -34.5885,
  lng: -58.4106,
  openingHours: 'Lun a Vie 9 a 20',
};
const belgrano: HopPoint = { ...palermo, id: 'hop-belgrano', name: 'Punto HOP Belgrano', address: 'Av. Cabildo 2040, CABA' };

/** Listo en Palermo, vence el jueves 22/10 a las 23:59:59 de BA. */
const ready: Package = {
  trackingId: 'HOP-0001',
  phone: PHONE,
  customerName: 'Ana',
  status: 'READY_AT_HOP',
  hopPointId: 'hop-palermo',
  deadlineAt: '2026-10-23T02:59:59.000Z',
  readyNotificationStatus: 'SENT',
  updatedAt: '2026-10-21T10:00:00Z',
};
const inTransit: Package = { ...ready, trackingId: 'HOP-0002', status: 'IN_TRANSIT', deadlineAt: undefined };
const delivered: Package = { ...ready, trackingId: 'HOP-0003', status: 'DELIVERED', deadlineAt: undefined };
const theirs: Package = { ...ready, trackingId: 'HOP-0009', phone: OTHER };

type AnyTool = { invoke(input: unknown): Promise<Record<string, unknown>> };

function setup() {
  const store = new Map([ready, inTransit, delivered, theirs].map((p) => [p.trackingId, p]));
  const repos = {
    getPackage: vi.fn(async (id: string) => store.get(id)),
    getHopPoint: vi.fn(async (id: string) => ({ 'hop-palermo': palermo, 'hop-belgrano': belgrano })[id]),
    updatePackageStatus: vi.fn(async (trackingId: string, patch: Partial<Package>) => ({
      ...store.get(trackingId)!,
      ...patch,
      updatedAt: NOW.toISOString(),
    })),
  } as unknown as Repos;
  const tools = createActionTools({ repos, phone: PHONE, now: () => NOW });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t as unknown as AnyTool]));
  /** Preview y confirmación, como lo hace el modelo después de que el cliente dice que sí. */
  async function confirm(name: string, input: Record<string, unknown>) {
    await byName[name]!.invoke({ ...input, confirmed: false });
    return byName[name]!.invoke({ ...input, confirmed: true });
  }
  return { repos, byName, confirm };
}

describe('tools de resolución del aviso', () => {
  it('expone exactamente las cuatro acciones', () => {
    const { byName } = setup();
    expect(Object.keys(byName).sort()).toEqual(['change_hop_point', 'extend_deadline', 'request_return', 'reschedule_delivery']);
  });

  describe('extend_deadline', () => {
    it('el preview muestra el plazo nuevo y no escribe nada', async () => {
      const { repos, byName } = setup();
      const res = await byName['extend_deadline']!.invoke({ trackingId: 'hop-0001', days: 3, confirmed: false });
      expect(res).toMatchObject({
        ok: true,
        preview: true,
        currentDeadlineLocal: 'jueves 22 de octubre',
        newDeadlineLocal: 'domingo 25 de octubre',
      });
      expect(repos.updatePackageStatus).not.toHaveBeenCalled();
    });

    it('confirmado después del preview, suma los días hasta el fin del día en BA', async () => {
      const { repos, confirm } = setup();
      const res = await confirm('extend_deadline', { trackingId: 'HOP-0001', days: 3 });
      expect(repos.updatePackageStatus).toHaveBeenCalledWith(
        'HOP-0001',
        { status: 'READY_AT_HOP', hopPointId: 'hop-palermo', deadlineAt: '2026-10-26T02:59:59.000Z' },
        NOW,
        { expectedUpdatedAt: '2026-10-21T10:00:00Z' },
      );
      expect(res).toMatchObject({ ok: true, package: { deadlineLocal: 'domingo 25 de octubre', daysLeft: 4 } });
    });

    it('rechaza más de 7 días', async () => {
      const { byName } = setup();
      await expect(byName['extend_deadline']!.invoke({ trackingId: 'HOP-0001', days: 8, confirmed: false })).rejects.toThrow();
    });

    it('solo extiende paquetes que están listos para retirar', async () => {
      const { repos, byName } = setup();
      const res = await byName['extend_deadline']!.invoke({ trackingId: 'HOP-0002', days: 2, confirmed: false });
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/listo para retirar/) });
      expect(repos.updatePackageStatus).not.toHaveBeenCalled();
    });
  });

  describe('change_hop_point', () => {
    it('pasa el paquete al punto nuevo, en camino y con el aviso reseteado para que se avise al llegar', async () => {
      const { repos, byName, confirm } = setup();
      const preview = await byName['change_hop_point']!.invoke({ trackingId: 'HOP-0001', hopPointId: 'hop-belgrano', confirmed: false });
      expect(preview).toMatchObject({ ok: true, preview: true, newHopPoint: { name: 'Punto HOP Belgrano' } });
      const res = await confirm('change_hop_point', { trackingId: 'HOP-0001', hopPointId: 'hop-belgrano' });
      expect(repos.updatePackageStatus).toHaveBeenCalledWith(
        'HOP-0001',
        { status: 'IN_TRANSIT', hopPointId: 'hop-belgrano', resetReadyNotification: true },
        NOW,
        { expectedUpdatedAt: '2026-10-21T10:00:00Z' },
      );
      expect(res).toMatchObject({ ok: true, hopPoint: { id: 'hop-belgrano' } });
    });

    it('rechaza un punto que no existe o el mismo en el que ya está', async () => {
      const { repos, byName } = setup();
      expect(await byName['change_hop_point']!.invoke({ trackingId: 'HOP-0001', hopPointId: 'hop-nope', confirmed: false })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/list_hop_points/),
      });
      expect(
        await byName['change_hop_point']!.invoke({ trackingId: 'HOP-0001', hopPointId: 'hop-palermo', confirmed: false }),
      ).toMatchObject({
        ok: false,
        error: expect.stringMatching(/ya está/),
      });
      expect(repos.updatePackageStatus).not.toHaveBeenCalled();
    });
  });

  describe('reschedule_delivery', () => {
    it('guarda la fecha a las 12 de BA y deja el paquete en camino', async () => {
      const { repos, byName, confirm } = setup();
      const preview = await byName['reschedule_delivery']!.invoke({ trackingId: 'HOP-0001', date: '2026-10-27', confirmed: false });
      expect(preview).toMatchObject({ ok: true, preview: true, scheduledLocal: 'martes 27 de octubre' });
      await confirm('reschedule_delivery', { trackingId: 'HOP-0001', date: '2026-10-27' });
      expect(repos.updatePackageStatus).toHaveBeenCalledWith(
        'HOP-0001',
        { status: 'IN_TRANSIT', scheduledAt: '2026-10-27T15:00:00.000Z', resetReadyNotification: true },
        NOW,
        { expectedUpdatedAt: '2026-10-21T10:00:00Z' },
      );
    });

    it.each([
      ['una fecha que no existe', '2026-02-30'],
      ['hoy', '2026-10-21'],
      ['una fecha pasada', '2026-10-20'],
      ['más de 14 días', '2026-11-30'],
    ])('rechaza %s sin escribir', async (_name, date) => {
      const { repos, byName } = setup();
      const res = await byName['reschedule_delivery']!.invoke({ trackingId: 'HOP-0001', date, confirmed: false });
      expect(res).toMatchObject({ ok: false });
      expect(repos.updatePackageStatus).not.toHaveBeenCalled();
    });
  });

  describe('request_return', () => {
    it('avisa que es definitivo y, confirmado, devuelve el paquete al remitente', async () => {
      const { repos, byName, confirm } = setup();
      const preview = await byName['request_return']!.invoke({ trackingId: 'HOP-0002', confirmed: false });
      expect(preview).toMatchObject({ ok: true, preview: true, warning: expect.stringMatching(/definitivo/) });
      await confirm('request_return', { trackingId: 'HOP-0002' });
      expect(repos.updatePackageStatus).toHaveBeenCalledWith('HOP-0002', { status: 'RETURNED', resetReadyNotification: true }, NOW, {
        expectedUpdatedAt: '2026-10-21T10:00:00Z',
      });
    });
  });

  describe('salvaguardas', () => {
    it('no toca paquetes de otro cliente', async () => {
      const { repos, confirm } = setup();
      expect(await confirm('request_return', { trackingId: 'HOP-0009' })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/no encontré/i),
      });
      expect(repos.updatePackageStatus).not.toHaveBeenCalled();
    });

    it('no actúa sobre paquetes entregados o devueltos', async () => {
      const { repos, confirm } = setup();
      expect(await confirm('request_return', { trackingId: 'HOP-0003' })).toMatchObject({ ok: false });
      expect(await confirm('change_hop_point', { trackingId: 'HOP-0003', hopPointId: 'hop-belgrano' })).toMatchObject({ ok: false });
      expect(repos.updatePackageStatus).not.toHaveBeenCalled();
    });

    it('no ejecuta sin haber mostrado antes el preview de ese mismo cambio', async () => {
      const { repos, byName } = setup();
      const direct = await byName['extend_deadline']!.invoke({ trackingId: 'HOP-0001', days: 3, confirmed: true });
      expect(direct).toMatchObject({ ok: false, error: expect.stringMatching(/Primero/) });
      await byName['extend_deadline']!.invoke({ trackingId: 'HOP-0001', days: 3, confirmed: false });
      const other = await byName['extend_deadline']!.invoke({ trackingId: 'HOP-0001', days: 4, confirmed: true });
      expect(other).toMatchObject({ ok: false });
      expect(repos.updatePackageStatus).not.toHaveBeenCalled();
    });

    it('si el paquete cambió entre el preview y la confirmación, pide volver a consultarlo', async () => {
      const { repos, confirm } = setup();
      vi.mocked(repos.updatePackageStatus).mockRejectedValueOnce(new ConcurrentUpdateError('HOP-0001'));
      expect(await confirm('extend_deadline', { trackingId: 'HOP-0001', days: 2 })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/cambió/),
      });
    });
  });
});
