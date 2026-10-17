/**
 * Teléfonos: siempre E.164 con `+` (`+5491112345678`) en DynamoDB, en los logs enmascarados
 * y al enviar por End User Messaging Social (que exige el `+`).
 */

const E164 = /^\+[1-9]\d{7,14}$/;

export class InvalidPhoneError extends Error {
  constructor(raw: string) {
    // Solo la forma, nunca el número completo: este error termina en CloudWatch.
    super(`Teléfono inválido (${describeShape(raw)}): se espera E.164 con +, por ejemplo +5491112345678`);
    this.name = 'InvalidPhoneError';
  }
}

/**
 * `+54 9 11 1234-5678` → `+5491112345678`. Exige el `+` inicial: un número local sin código
 * de país ("11 1234-5678") NO se completa a ciegas, porque podría convertirse en un E.164
 * válido de otro país y el mensaje le llegaría a un desconocido.
 */
export function normalizePhone(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, '');
  if (!compact.startsWith('+') || !E164.test(compact)) throw new InvalidPhoneError(raw);
  return compact;
}

/**
 * El webhook de Meta trae `from`/`wa_id` en E.164 SIN `+` (`5491112345678`). Solo para esa
 * fuente se antepone el `+`.
 */
export function fromWaId(waId: string): string {
  return normalizePhone(waId.startsWith('+') ? waId : `+${waId}`);
}

/** Deja visibles solo los últimos 4 dígitos: `+5491112345678` → `***5678`. */
export function maskPhone(phone: string | undefined): string {
  if (!phone) return 'unknown';
  if (phone.length < 8) return '***';
  return `***${phone.slice(-4)}`;
}

function describeShape(raw: string): string {
  const digits = raw.replace(/\D/g, '').length;
  return `${raw.startsWith('+') ? 'con' : 'sin'} +, ${digits} dígitos`;
}
