// Bundles src/main.ts and the bridge client into web/index.js: one self-contained classic script, which is
// what the host runs in its sandboxed frame. From the repository root: node examples/plugins/session-stats/build.mjs
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'web/index.js'),
  bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'none',
  // Outside this repository, copy packages/plugin-web/src/{bridge,bridge-client}.ts next to the source instead.
  alias: { '@riffet/plugin-web/bridge-client': resolve(here, '../../../packages/plugin-web/src/bridge-client.ts') },
});
