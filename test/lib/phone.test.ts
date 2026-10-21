import { describe, expect, it } from 'vitest';
import { InvalidPhoneError, fromWaId, maskPhone, normalizePhone } from '../../src/lib/phone.js';

const PHONE = '+5491112345678';

describe('normalizePhone', () => {
  it('limpia separadores y conserva el +', () => {
    expect(normalizePhone('+54 9 11 1234-5678')).toBe(PHONE);
    expect(normalizePhone('(+54) 911 1234 5678')).toBe(PHONE);
    expect(normalizePhone(PHONE)).toBe(PHONE);
  });

  it('rechaza números sin + (un local podría volverse un E.164 válido de otro país)', () => {
    expect(() => normalizePhone('5491112345678')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('11 1234-5678')).toThrow(InvalidPhoneError);
  });

  it('rechaza lo que no es E.164', () => {
    expect(() => normalizePhone('+1234')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('+0123456789')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('hola')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('+54911123456789012')).toThrow(InvalidPhoneError);
  });

  it('el error no incluye el número completo', () => {
    try {
      normalizePhone('11 9876-5432');
      expect.unreachable();
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain('9876');
      expect((err as Error).message).not.toContain('5432');
    }
  });
});

describe('fromWaId', () => {
  it('antepone el + al wa_id de Meta (que viene sin +)', () => {
    expect(fromWaId('5491112345678')).toBe(PHONE);
    expect(fromWaId(PHONE)).toBe(PHONE);
    expect(() => fromWaId('abc')).toThrow(InvalidPhoneError);
  });
});

describe('maskPhone', () => {
  it('deja solo los últimos 4 dígitos', () => {
    expect(maskPhone(PHONE)).toBe('***5678');
    expect(maskPhone('+123456')).toBe('***');
    expect(maskPhone(undefined)).toBe('unknown');
  });
});
