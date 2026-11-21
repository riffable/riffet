// The session trace (docs/TRACE.md): a session view that reads a conversation's journal as it was written,
// every row and revision, beside the model requests the statistics ledger counted. It has no server side
// of its own: the rows come from the core's read-only `/api/sessions/:id/trace` routes, and the web client
// draws them from `web/` (registered in `plugins/web.ts`). Web only; the Mac app leaves it out (docs/guide/mac-scope.md, M).

import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';

export const trace: Plugin = {
  manifest: {
    id: 'riffet.trace', vendor: 'riffet', name: 'trace', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '1.0.0',
    title: { 'zh-Hans': 'Trace', en: 'Trace' },
    description: { 'zh-Hans': '逐条查看会话日志、工具调用、模型请求与耗时。', en: 'Inspect a conversation’s log, tool calls, model requests and timings row by row.' },
    contributes: {
      views: [{
        id: 'riffet.trace/trace', title: { 'zh-Hans': 'Trace', en: 'Trace' },
        locations: ['session-view'], clients: ['web'], instances: 'per-session',
      }],
    },
  },
  activate: () => ({}),
};
