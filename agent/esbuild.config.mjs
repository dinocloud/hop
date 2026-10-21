// Bundle del agente para AgentCore Runtime (deploy de código directo, NODE_22).
// Un solo archivo CommonJS con todas las dependencias: el zip no lleva node_modules.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, 'dist');
mkdirSync(outdir, { recursive: true });

/**
 * `bedrock-agentcore/runtime` carga `@fastify/sse` y `@fastify/websocket` con
 * `createRequire(import.meta.url)`. esbuild no sigue los require hechos con un createRequire
 * local, así que esos paquetes quedarían fuera del bundle y el runtime fallaría al cargar
 * (localmente funciona solo porque encuentra node_modules). Este plugin reemplaza ese
 * createRequire por el `require` normal para que esbuild los incluya.
 */
const inlineCreateRequire = {
  name: 'inline-create-require',
  setup(buildApi) {
    buildApi.onLoad({ filter: /bedrock-agentcore[\\/]dist[\\/]src[\\/]runtime[\\/]app\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      const patched = source.replace(/const require = createRequire\(import\.meta\.url\);/, '');
      if (patched === source) throw new Error(`No se encontró createRequire en ${args.path}: revisar el plugin`);
      return { contents: patched, loader: 'js' };
    });
  },
};

await build({
  entryPoints: [resolve(here, 'src', 'server.ts')],
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
  // Dependencia opcional de pino que no se usa y rompería el bundle.
  external: ['pino-pretty'],
  plugins: [inlineCreateRequire],
  // Algunas dependencias usan `import.meta.url`. En CJS esbuild lo deja en undefined,
  // así que se reemplaza por la URL del propio bundle.
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
