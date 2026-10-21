/**
 * Fechas del dominio. Los plazos de retiro se expresan en días y vencen al final del día
 * en la zona horaria de los Puntos HOP (Argentina, UTC-3 sin horario de verano desde 2009).
 */

export const BUENOS_AIRES_OFFSET_MINUTES = -180;

/**
 * Fin del día (23:59:59) de `daysAhead` días después de `now`, en hora de Buenos Aires.
 * Ej.: now = 2026-10-17T12:00:00Z (09:00 BA), daysAhead = 5 → 2026-10-22T23:59:59-03:00.
 */
export function endOfDayInBuenosAires(now: Date, daysAhead: number): Date {
  const offsetMs = BUENOS_AIRES_OFFSET_MINUTES * 60 * 1000;
  // Reloj local de BA expresado en campos UTC.
  const local = new Date(now.getTime() + offsetMs);
  const endLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead, 23, 59, 59, 0);
  return new Date(endLocal - offsetMs);
}
