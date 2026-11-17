// 翻译's page in the plugin's details (docs/PLUGIN_ARCHITECTURE.md「插件页」): the language answers are translated into.

import type { PluginHost, PluginPageProvider } from '@riffet/plugin-api';
import { AUTO, LANGUAGES } from './languages.js';

const WORDS = {
  en: { target: 'Translate into', auto: 'Language of the app', footer: 'Messages are sent to the model chosen for Translation in Settings › Auxiliary models; until one is, to the default model of Quick chat.' },
  zh: { target: '译成', auto: '跟随界面语言', footer: '消息会发给「设置 › 辅助模型」里为翻译选择的模型，没有选择时用「快速对话」的默认模型。' },
};

export function translatePage(host: PluginHost): PluginPageProvider {
  return {
    read({ locale }) {
      const words = locale.toLowerCase().startsWith('zh') ? WORDS.zh : WORDS.en;
      const saved = host.settings().target;
      const value = saved && LANGUAGES.some(language => language.tag === saved) ? saved : AUTO;
      return {
        sections: [{
          id: 'translate',
          footer: words.footer,
          items: [{
            kind: 'choice', key: 'target', label: words.target, value,
            options: [{ value: AUTO, label: words.auto }, ...LANGUAGES.map(language => ({ value: language.tag, label: language.name }))],
          }],
        }],
      };
    },
  };
}
