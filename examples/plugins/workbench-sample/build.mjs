// Builds the isolated view from the SDK and source, from the repository root:
// node examples/plugins/workbench-sample/build.mjs
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'web/index.js'),
  bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'none',
  alias: { '@riffet/plugin-web/bridge-client': resolve(here, '../../../packages/plugin-web/src/bridge-client.ts') },
});
