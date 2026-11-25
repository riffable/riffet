// Feishu / Lark bots (docs/design/channels.md): the reference for `contributes.imChannels`. The channel layer in the core
// owns accounts, the gate, bindings and the conversations; this plugin only speaks the platform: a long connection in,
// cards and a native process message out. Turning it off disconnects the bots and keeps them, with their chats, for the
// next time it is on.

import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';

export const FEISHU_CHANNEL = 'riffet.channel-feishu/feishu';

export const channelFeishu: Plugin = {
  manifest: {
    id: 'riffet.channel-feishu', vendor: 'riffet', name: 'channel-feishu', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '1.0.0',
    title: { 'zh-Hans': '飞书机器人', en: 'Feishu Bot' },
    description: { 'zh-Hans': '在飞书或 Lark 里和 Riffet 的会话对话。', en: 'Talk to Riffet conversations from Feishu or Lark.' },
    activation: ['startup'],
    contributes: {
      imChannels: [{ id: FEISHU_CHANNEL, title: { 'zh-Hans': '飞书', en: 'Feishu' } }],
    },
  },
  // The Lark SDK loads only once the plugin is on.
  activate: async () => ({ imChannels: { [FEISHU_CHANNEL]: (await import('./provider.js')).feishuProvider } }),
};
