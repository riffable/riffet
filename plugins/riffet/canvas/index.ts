// The conversation canvas (docs/design/plugin-system.md §4): a session view that draws a conversation
// and its forks as flows. It has no server side: the manifest declares the view, and the web client
// draws it from `web/` (registered in `plugins/web.ts`). Turning the plugin off removes the view
// from the session's switch and from the 视图 settings on every client; turning it on restores it.

import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';

export const canvas: Plugin = {
  manifest: {
    id: 'riffet.canvas', vendor: 'riffet', name: 'canvas', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '1.0.0',
    title: { 'zh-Hans': '画布', en: 'Canvas' },
    description: { 'zh-Hans': '以流程图查看会话消息与分支。', en: 'View conversation messages and branches as a flowchart.' },
    contributes: {
      views: [{
        id: 'riffet.canvas/canvas', title: { 'zh-Hans': '画布', en: 'Canvas' },
        locations: ['session-view'], clients: ['web'], instances: 'per-session',
      }],
    },
  },
  activate: () => ({}),
};
