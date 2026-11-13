// A browser the Agent drives and the user watches (docs/BROWSER.md). The server side runs Chromium through
// `playwright-core` and gives the conversation's CLI the `browser_*` tools through Riffet MCP; the web panel
// (`web/`) and the macOS panel (`apps/macos/Riffet/Features/Browser`) draw its frames and pass input back over the
// `live` channel. Turning the plugin off closes every browser; the profiles stay for the next time it is on.

import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';

export const browser: Plugin = {
  manifest: {
    id: 'riffet.browser', vendor: 'riffet', name: 'browser', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '1.0.0',
    title: { 'zh-Hans': '浏览器', en: 'Browser' },
    description: { 'zh-Hans': '让 Agent 操作一个由 Riffet 托管的浏览器，你也可以随时一起操作。', en: 'Lets the Agent use a browser Riffet hosts; you can use it too at any time.' },
    // Edited on the plugin's page (page.ts), not as a form.
    settings: [
      { key: 'browser', label: 'Browser', kind: 'text' },
      { key: 'executablePath', label: 'Browser path', kind: 'text' },
      { key: 'allowSites', label: 'Sites that need no confirmation', kind: 'text' },
      { key: 'blockSites', label: 'Blocked sites', kind: 'text' },
    ],
    contributes: {
      page: {},
      agentTools: [{
        id: 'riffet.browser/browser', toolPrefix: 'browser_',
        // Named apart from other browser tools an Agent may have.
        title: { 'zh-Hans': 'Riffet 浏览器', en: 'Riffet Browser' },
        description: { 'zh-Hans': '打开网页、读取页面、点击与输入', en: 'Open pages, read them, click and type' },
        icon: { sfSymbol: 'globe' },
      }],
      channels: [{ id: 'riffet.browser/live', scope: 'session' }],
      views: [{
        id: 'riffet.browser/panel', title: { 'zh-Hans': '浏览器', en: 'Browser' }, icon: { sfSymbol: 'globe' },
        locations: ['sidebar'], clients: ['web', 'macos'], instances: 'per-session', when: { hasSession: true },
      }],
    },
  },
  // Playwright loads only once the plugin is on.
  activate: async (host, scope) => (await import('./activate.js')).activate(host, scope),
};
