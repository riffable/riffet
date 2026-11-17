// 翻译 (docs/PLUGIN_ARCHITECTURE.md「消息菜单」): a 翻译 item in each answer's more menu. The reference for a
// command listed in a host menu: it declares the menu and an icon, runs on the message the client sends, and answers
// Markdown the client shows under that message. It has no client code, so every client draws it the same way, and
// no key of its own: it declares a model use, which the 辅助模型 settings page lists as 翻译, and runs on the model
// chosen there, or on 快速对话's while none is, through `host.models.complete`.

import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';
import { translatePage } from './page.js';
import { Translator } from './translator.js';

export const TRANSLATE_COMMAND = 'riffet.translate/translate';
export const TRANSLATE_MODEL = 'riffet.translate/translation';

export const translate: Plugin = {
  manifest: {
    id: 'riffet.translate', vendor: 'riffet', name: 'translate', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '1.0.0',
    title: { 'zh-Hans': '翻译', en: 'Translate' },
    description: { 'zh-Hans': '在回答的更多菜单里翻译这条回答，或翻译选中的文字。', en: 'Translates an answer from its more menu, or the text selected in one.' },
    // Edited on the plugin's page (page.ts); `auto` or absent follows the language of the client that asks.
    settings: [{ key: 'target', label: 'Target language', kind: 'text' }],
    activation: ['command'],
    contributes: {
      page: {},
      modelUses: [{ id: TRANSLATE_MODEL, title: { 'zh-Hans': '翻译', en: 'Translation' }, fallback: 'chat' }],
      commands: [{
        id: TRANSLATE_COMMAND, title: { 'zh-Hans': '翻译', en: 'Translate' },
        scope: 'session', menus: ['message', 'selection'], icon: 'languages',
      }],
    },
  },
  activate(host) {
    const translator = new Translator(host);
    return {
      page: translatePage(host),
      commands: { [TRANSLATE_COMMAND]: { run: context => translator.run(context) } },
      dispose: () => translator.clear(),
    };
  },
};
