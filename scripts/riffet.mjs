#!/usr/bin/env node
// `riffet` from a source checkout or an npm install: the command itself is the build, dist/cli.js.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node resolves the installed symlink to this file, so any working directory works.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist/cli.js');
if (!existsSync(entry)) {
  console.error(`✗ Riffet is not built yet\n  → cd ${root} && pnpm build`);
  process.exit(1);
}
// Native CLI hooks and MCP entries are written with absolute paths into dist/, and npm may delete its
// npx cache, which would leave them pointing at nothing.
if (/[\\/]_npx[\\/]/.test(root)) console.error('! Running from the npx cache, which npm may clear; hooks Riffet installs would then break\n  → npm i -g riffet');
const { main } = await import(pathToFileURL(entry).href);
await main();
