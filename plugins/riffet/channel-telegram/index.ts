import { PLUGIN_API_VERSION, type Plugin, type PluginManifest } from '@riffet/plugin-api';
import { TELEGRAM_CHANNEL } from './constants.js';

export { TELEGRAM_CHANNEL };

const manifest: PluginManifest = {
  id: 'riffet.channel-telegram',
  vendor: 'riffet',
  name: 'channel-telegram',
  apiVersion: PLUGIN_API_VERSION,
  defaultEnabled: true,
  version: '1.0.0',
  title: { 'zh-Hans': 'Telegram 机器人', en: 'Telegram Bot' },
  description: {
    'zh-Hans': '在 Telegram 私聊和群聊里和 Riffet 对话，支持流式输出、话题与按钮交互。',
    en: 'Talk to Riffet from Telegram private chats and groups, with streaming drafts, topics, and inline actions.',
  },
  contributes: {
    imChannels: [{ id: TELEGRAM_CHANNEL, title: { 'zh-Hans': 'Telegram', en: 'Telegram' } }],
  },
};

export const channelTelegram: Plugin = {
  manifest,
  async activate() {
    const { createTelegramProvider } = await import('./provider.js');
    return { imChannels: { [TELEGRAM_CHANNEL]: createTelegramProvider() } };
  },
};
