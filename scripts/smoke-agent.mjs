// Verifica que el bundle del agente carga en una carpeta AISLADA (sin node_modules), como en
// AgentCore Runtime. Detecta dependencias que esbuild haya dejado fuera.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('agent', 'dist');
const dir = mkdtempSync(join(tmpdir(), 'hop-agent-smoke-'));
try {
  cpSync(dist, dir, { recursive: true });
  process.env.HOP_AGENT_SMOKE = '1';
  for (const name of ['PACKAGES_TABLE', 'HOP_POINTS_TABLE', 'CONVERSATIONS_TABLE', 'INBOUND_MESSAGES_TABLE']) {
    process.env[name] ??= 'smoke';
  }
  process.env.AWS_REGION ??= 'us-east-1';
  const require = createRequire(join(dir, 'index.js'));
  require(join(dir, 'index.js'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
