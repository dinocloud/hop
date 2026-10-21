import { describe, expect, it } from 'vitest';
import { HOP_POINTS, buildPackages, parseSeedPhones } from '../../scripts/seed.js';

describe('seed', () => {
  it('valida teléfonos E.164 con +', () => {
    expect(parseSeedPhones('+5491112345678, +5491187654321')).toEqual(['+5491112345678', '+5491187654321']);
    expect(() => parseSeedPhones('5491112345678')).toThrow(/inválido/);
    expect(parseSeedPhones(undefined)).toEqual(['+5491100000000']);
  });

  it('genera paquetes determinísticos que referencian Puntos HOP existentes', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const packages = buildPackages(['+5491112345678'], now);
    expect(packages).toHaveLength(10);
    expect(packages[0]?.trackingId).toBe('HOP-0001');
    const hopIds = new Set(HOP_POINTS.map((h) => h.id));
    for (const pkg of packages) {
      expect(hopIds.has(pkg.hopPointId ?? '')).toBe(true);
      if (pkg.status === 'READY_AT_HOP') expect(pkg.deadlineAt).toBeDefined();
    }
    expect(buildPackages(['+5491112345678'], now)).toEqual(packages);
  });

  it('reparte los paquetes entre los teléfonos del equipo', () => {
    const packages = buildPackages(['+5491100000001', '+5491100000002']);
    expect(packages[0]?.phone).toBe('+5491100000001');
    expect(packages[1]?.phone).toBe('+5491100000002');
    expect(packages[2]?.phone).toBe('+5491100000001');
  });
});
