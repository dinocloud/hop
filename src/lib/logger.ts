import { Logger } from '@aws-lambda-powertools/logger';

export { maskPhone } from './phone.js';

/**
 * Logger JSON estructurado (Powertools). El `serviceName` lo fija la variable
 * `POWERTOOLS_SERVICE_NAME` que define el stack por Lambda.
 *
 * Nunca loguear el teléfono completo: usar `maskPhone`. Los errores de la lib tampoco
 * guardan el número completo en sus propiedades (Powertools las vuelca al log).
 */
export const logger = new Logger();
