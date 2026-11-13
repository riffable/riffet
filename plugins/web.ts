// The client entries of the built-in plugins (docs/PLUGIN_ARCHITECTURE.md), as `index.ts` lists the server
// side. Each loads on demand: the web app reads an entry only once the plugin is on, and the entry
// keeps its heavy views behind their own dynamic imports. Only `apps/web/src/plugins/registry.ts`
// imports this file.

import type { WebPlugin } from '@riffet/plugin-web';

export interface BuiltinWebPlugin {
  /** The plugin id, as in `plugins/index.ts`. */
  id: string;
  load: () => Promise<{ default: WebPlugin }>;
}

export const builtinWebPlugins: BuiltinWebPlugin[] = [
  { id: 'riffet.canvas', load: () => import('./riffet/canvas/web/index.js') },
  { id: 'riffet.browser', load: () => import('./riffet/browser/web/index.js') },
  { id: 'riffet.cursor', load: () => import('./riffet/cursor/web/index.js') },
];
