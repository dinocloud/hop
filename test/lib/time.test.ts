import { describe, expect, it } from 'vitest';
import { endOfDayInBuenosAires } from '../../src/lib/time.js';

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
