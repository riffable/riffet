// The built-in plugins, in precedence order (docs/PLUGIN_ARCHITECTURE.md). Each lives in
// `plugins/<vendor>/<name>/` and imports only `@riffet/plugin-api`, `@contracts`, Node
// built-ins and npm dependencies; `pnpm check:plugins` enforces it.

import type { Plugin } from '@riffet/plugin-api';
import { antigravity } from './riffet/antigravity/index.js';
import { avatars } from './riffet/avatars/index.js';
import { browser } from './riffet/browser/index.js';
import { canvas } from './riffet/canvas/index.js';
import { cursor } from './riffet/cursor/index.js';

export const builtinPlugins: Plugin[] = [
  cursor,
  antigravity,
  canvas,
  browser,
  avatars,
];
