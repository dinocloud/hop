import { describe, expect, it } from 'vitest';
import { nextTrackingId, parseArgs } from '../../scripts/add-package.js';

describe('parseArgs', () => {
  it('toma el teléfono y aplica los defaults de la demo', () => {
    const o = parseArgs(['+54 9 11 1234-5678']);
    expect(o).toMatchObject({
      phone: '+5491112345678',
      customerName: 'Cliente',
      status: 'READY_AT_HOP',
      hopPointId: 'hop-palermo',
      deadlineDays: 5,
    });
  });

  it('lee las opciones', () => {
    const o = parseArgs(['+5491112345678', '--name', 'Lean', '--point', 'hop-belgrano', '--days', '3']);
    expect(o).toMatchObject({ customerName: 'Lean', hopPointId: 'hop-belgrano', deadlineDays: 3 });
  });

  it('rechaza que falte el teléfono', () => {
    expect(() => parseArgs([])).toThrow(/Falta el teléfono/);
    expect(() => parseArgs(['--name', 'Lean'])).toThrow(/Falta el teléfono/);
  });

  it('rechaza un teléfono que no sea E.164', () => {
    expect(() => parseArgs(['1161186395'])).toThrow();
  });

  it('rechaza un estado inexistente', () => {
    expect(() => parseArgs(['+5491112345678', '--status', 'PERDIDO'])).toThrow(/Estado inválido/);
  });

  it('no deja poner plazo a un estado que no lo tiene', () => {
    expect(() => parseArgs(['+5491112345678', '--status', 'IN_TRANSIT', '--days', '3'])).toThrow(/solo aplica con/);
  });

  it('acota los días al rango permitido', () => {
    expect(() => parseArgs(['+5491112345678', '--days', '0'])).toThrow(/entero de 1 a 30/);
    expect(() => parseArgs(['+5491112345678', '--days', '31'])).toThrow(/entero de 1 a 30/);
    expect(() => parseArgs(['+5491112345678', '--days', 'tres'])).toThrow(/entero de 1 a 30/);
  });

  it('exige la forma HOP-0042 en --id', () => {
    expect(() => parseArgs(['+5491112345678', '--id', 'HOP-1'])).toThrow(/forma HOP-0042/);
    expect(parseArgs(['+5491112345678', '--id', 'HOP-0042']).trackingId).toBe('HOP-0042');
  });

  it('rechaza una opción sin valor', () => {
    expect(() => parseArgs(['+5491112345678', '--name'])).toThrow(/mal formada/);
  });
});

describe('nextTrackingId', () => {
  it('sigue la numeración del mayor existente', () => {
    expect(nextTrackingId(['HOP-0001', 'HOP-0010', 'HOP-0003'])).toBe('HOP-0011');
  });

  it('arranca en HOP-0001 cuando no hay nada', () => {
    expect(nextTrackingId([])).toBe('HOP-0001');
  });

  it('ignora ids que no siguen el patrón', () => {
    expect(nextTrackingId(['HOP-0002', 'DEMO-X', 'HOP-abc'])).toBe('HOP-0003');
  });

  it('no se queda sin ancho cuando pasa de 9999', () => {
    expect(nextTrackingId(['HOP-9999'])).toBe('HOP-10000');
  });
});
