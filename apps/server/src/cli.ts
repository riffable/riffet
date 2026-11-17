#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from './cli/main.js';

// `riffet-server`, and the module `scripts/riffet.mjs` runs as `riffet`. The commands live in cli/.
export { main };
const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(entry)) void main();
