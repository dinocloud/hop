import { describe, expect, it } from 'vitest';
import { calendarDaysUntilInBuenosAires, endOfDayInBuenosAires, formatDayInBuenosAires, isoDateInBuenosAires } from '../../src/lib/time.js';

describe('endOfDayInBuenosAires', () => {
  it('vence a las 23:59:59 de Buenos Aires del día N', () => {
    // 2026-10-17T12:00Z son las 09:00 en BA → 5 días después: 2026-10-22 23:59:59 -03:00
    expect(endOfDayInBuenosAires(new Date('2026-10-17T12:00:00Z'), 5).toISOString()).toBe('2026-10-23T02:59:59.000Z');
  });

  it('respeta el cambio de día de Buenos Aires, no el de UTC', () => {
    // 2026-10-18T01:00Z todavía es 17/10 22:00 en BA → 1 día: 18/10 23:59:59 -03:00
    expect(endOfDayInBuenosAires(new Date('2026-10-18T01:00:00Z'), 1).toISOString()).toBe('2026-10-19T02:59:59.000Z');
  });

  it('cruza fin de mes y de año', () => {
    expect(endOfDayInBuenosAires(new Date('2026-12-31T12:00:00Z'), 2).toISOString()).toBe('2027-01-03T02:59:59.000Z');
  });
});

describe('formatDayInBuenosAires', () => {
  it('nombra el día de Buenos Aires, no el de UTC', () => {
    // 2026-10-23T02:59:59Z todavía es jueves 22/10 23:59:59 en BA
    expect(formatDayInBuenosAires(new Date('2026-10-23T02:59:59.000Z'))).toBe('jueves 22 de octubre');
    expect(formatDayInBuenosAires(new Date('2026-10-23T03:00:00.000Z'))).toBe('viernes 23 de octubre');
  });
});

describe('calendarDaysUntilInBuenosAires', () => {
  it('cuenta días de calendario en BA: 0 hoy, 1 mañana, negativo si ya pasó', () => {
    const now = new Date('2026-10-21T15:00:00Z'); // miércoles 21/10, 12:00 en BA
    expect(calendarDaysUntilInBuenosAires(new Date('2026-10-22T02:59:59.000Z'), now)).toBe(0);
    expect(calendarDaysUntilInBuenosAires(new Date('2026-10-23T02:59:59.000Z'), now)).toBe(1);
    expect(calendarDaysUntilInBuenosAires(new Date('2026-10-20T15:00:00.000Z'), now)).toBe(-1);
  });
});

describe('isoDateInBuenosAires', () => {
  it('da la fecha YYYY-MM-DD de Buenos Aires', () => {
    // 2026-10-18T02:00Z todavía son las 23:00 del 17/10 en BA
    expect(isoDateInBuenosAires(new Date('2026-10-18T02:00:00Z'))).toBe('2026-10-17');
    expect(isoDateInBuenosAires(new Date('2026-10-18T03:00:00Z'))).toBe('2026-10-18');
  });
});
