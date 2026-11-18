// 本机识别 (docs/VOICE.md §5): dictation's recognizer that runs on the server. Nothing is bundled: the engine
// (sherpa-onnx) and the models are downloaded from the plugin's page, and recognition runs in one worker process.

import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';
import { Installer } from './install.js';
import { speechLocalPage } from './page.js';
import { MODELS } from './pins.js';
import { LocalRecognizer } from './recognizer.js';

const TITLE = { 'zh-Hans': '本机语音识别', en: 'Local speech recognition' };

export const speechLocal: Plugin = {
  manifest: {
    id: 'riffet.speech-local', vendor: 'riffet', name: 'speech-local', apiVersion: PLUGIN_API_VERSION, defaultEnabled: false, version: '1.0.0',
    title: TITLE,
    description: { 'zh-Hans': '在服务器上把语音识别成文字，引擎和模型在插件页下载。', en: 'Turns speech into text on the server; the engine and models are downloaded on the plugin page.' },
    contributes: { speechRecognizer: { title: TITLE }, page: { title: { 'zh-Hans': '模型', en: 'Models' } } },
  },
  async activate(host, scope) {
    let recognizer: LocalRecognizer | undefined;
    const installer = new Installer(await host.stateDir(), removed => (removed ? recognizer?.stop('Local speech recognition changed') : recognizer?.refresh()));
    await installer.sweep();
    recognizer = new LocalRecognizer(host, installer);
    const active = recognizer;
    scope.onDispose(() => { installer.cancelAll(); active.stop('Local speech recognition is off'); });
    return {
      speechRecognizer: active, page: speechLocalPage(installer),
      // What the plugin list and 语音输入 settings show: recognition needs the engine and at least one model.
      async status() {
        const ready = await installer.engineInstalled() && (await Promise.all(MODELS.map(pin => installer.modelInstalled(pin.id)))).some(Boolean);
        return ready ? { state: 'ready' } : { state: 'attention', message: 'Download a model on the Models page' };
      },
    };
  },
};
