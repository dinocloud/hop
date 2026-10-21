/**
 * Fechas del dominio. Los plazos de retiro se expresan en días y vencen al final del día
 * en la zona horaria de los Puntos HOP (Argentina, UTC-3 sin horario de verano desde 2009).
 */

export const BUENOS_AIRES_OFFSET_MINUTES = -180;

const OFFSET_MS = BUENOS_AIRES_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Reloj local de BA expresado en campos UTC. */
function buenosAiresClock(date: Date): Date {
  return new Date(date.getTime() + OFFSET_MS);
}

/**
 * Fin del día (23:59:59) de `daysAhead` días después de `now`, en hora de Buenos Aires.
 * Ej.: now = 2026-10-17T12:00:00Z (09:00 BA), daysAhead = 5 → 2026-10-22T23:59:59-03:00.
 */
export function endOfDayInBuenosAires(now: Date, daysAhead: number): Date {
  const local = buenosAiresClock(now);
  const endLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead, 23, 59, 59, 0);
  return new Date(endLocal - OFFSET_MS);
}

/** El día de Buenos Aires como lo dice una persona: "jueves 22 de octubre". */
export function formatDayInBuenosAires(date: Date): string {
  const local = buenosAiresClock(date);
  return `${WEEKDAYS[local.getUTCDay()]} ${local.getUTCDate()} de ${MONTHS[local.getUTCMonth()]}`;
}

/** Días de calendario de Buenos Aires entre `now` y `date`: 0 = hoy, 1 = mañana, negativo = ya pasó. */
export function calendarDaysUntilInBuenosAires(date: Date, now: Date): number {
  const dayNumber = (d: Date) => Math.floor(buenosAiresClock(d).getTime() / DAY_MS);
  return dayNumber(date) - dayNumber(now);
}
