import { createApp, main } from './index.js';

/**
 * Entry point del bundle (agent/dist/index.js). Siempre arranca el servidor, sin depender de
 * cómo invoque el runtime al archivo. Con `HOP_AGENT_SMOKE=1` solo construye la app y sale:
 * lo usa `npm run smoke:agent` para verificar que el bundle carga en una carpeta aislada.
 */
if (process.env.HOP_AGENT_SMOKE === '1') {
  createApp();
  console.log('smoke ok: el bundle carga y la app se construye');
} else {
  main();
}
