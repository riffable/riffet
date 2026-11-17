// The plugin's page: the conversations with recordings, their size, and where they are on the server.

import { type PluginHost, type PluginPage, type PluginPageProvider } from '@riffet/plugin-api';
import { type Recordings } from './recorder.js';

const EN = { title: 'Recordings', empty: 'Recordings of Claude Code conversations appear here', clear: 'Clear', confirm: 'Clear these recordings?', conversation: 'Conversation', footer: 'Bodies are cut at 64 KB. Credentials are not saved.' };
const ZH: typeof EN = { title: '记录', empty: 'Claude Code 对话的记录会出现在这里', clear: '清除', confirm: '清除这些记录？', conversation: '对话', footer: '正文截取前 64 KB，不保存凭据' };

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function recorderPage(host: PluginHost, recordings: () => Promise<Recordings>): PluginPageProvider {
  return {
    async read({ locale }): Promise<PluginPage> {
      const t = locale.toLowerCase().startsWith('zh') ? ZH : EN;
      const list = await (await recordings()).list();
      const items: PluginPage['sections'][number]['items'] = list.map(item => ({
        kind: 'row', id: item.name, label: `${t.conversation} ${item.name.slice(0, 8)}`, value: bytes(item.bytes),
        detail: `${new Date(item.lastAt).toLocaleString(locale)} · ${item.dir}`,
        buttons: [{ action: 'clear', item: item.name, label: t.clear, destructive: true, confirm: t.confirm }],
      }));
      if (!items.length) items.push({ kind: 'row', id: 'empty', label: t.empty });
      return { sections: [{ id: 'recordings', title: t.title, footer: t.footer, items }] };
    },
    async run(_context, action, item) {
      if (action === 'clear' && item) { await (await recordings()).clear(item); return; }
      throw host.error('UNKNOWN_ACTION', `Unknown action ${action}`, 404);
    },
  };
}

