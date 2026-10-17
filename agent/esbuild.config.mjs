// Bundle del agente para AgentCore Runtime (deploy de código directo, NODE_22).
// Un solo archivo CommonJS con todas las dependencias: el zip no lleva node_modules.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, 'dist');
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve(here, 'src', 'index.ts')],
  outfile: resolve(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // Sin source map embebido y minificado: el zip va a S3 y lo carga el runtime en cada sesión.
  sourcemap: false,
  minify: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
  // Dependencias opcionales de Fastify/pino que no se usan y romperían el bundle.
  external: ['pino-pretty'],
  // Algunas dependencias usan `import.meta.url` (createRequire). En CJS esbuild lo deja en
  // undefined, así que se reemplaza por la URL del propio bundle.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: {
    js: [
      '/* HOP hackathon - agente AgentCore. Generado por agent/esbuild.config.mjs */',
      "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    ].join('\n'),
  },
});

// package.json mínimo para que Node trate el bundle como CommonJS.
writeFileSync(resolve(outdir, 'package.json'), JSON.stringify({ name: 'hop-agent', private: true, type: 'commonjs' }, null, 2));
