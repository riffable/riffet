// 本机识别's page in the plugin's details (docs/PLUGIN_ARCHITECTURE.md「插件页」): the models first, each saying what it gives,
// then the engine they run on, which installs itself with the first model. Downloads run on after a button returns and are
// drawn as meters; the page reads again each second meanwhile.

import type { PluginPage, PluginPageButton, PluginPageItem, PluginPageProvider } from '@riffet/plugin-api';
import { enginePlatform, type InstallError, type InstallKind, type Installer } from './install.js';
import { ENGINE_VERSION, MODELS, type ModelId } from './pins.js';

const EN = {
  engine: 'Engine', engineName: 'Speech engine',
  install: 'Install', download: 'Download', downloadAll: 'Download both', remove: 'Delete', cancel: 'Cancel',
  installed: 'Installed', downloaded: 'Downloaded', notInstalled: 'Not installed', notDownloaded: 'Not downloaded', failed: 'Failed',
  waiting: 'Waiting for the engine', withFirstModel: 'Installed with the first model',
  unsupported: (platform: string) => `This server (${platform}) is not supported`,
  network: (host: string) => `Could not reach ${host}`, checksum: (file: string) => `${file} did not match its checksum`, engineFailed: 'The engine could not be installed',
  zipformer: 'Streaming Zipformer', sensevoice: 'SenseVoice',
  zipformerDetail: 'Text appears as you speak, punctuated only at pauses · Chinese, English',
  sensevoiceDetail: 'Each sentence appears once spoken, with punctuation and fewer mistakes · Chinese, English, Japanese, Korean, Cantonese',
  modelsFooter: 'Both is best: text appears as you speak, and SenseVoice corrects each sentence once it ends.',
  removeModel: (name: string) => `Delete ${name}?`, removeModelDetail: 'It can be downloaded again.',
  removeEngine: 'Delete the speech engine?', removeEngineDetail: 'Local recognition stops working until it is installed again; the models are kept.',
};
const ZH: typeof EN = {
  engine: '引擎', engineName: '识别引擎',
  install: '安装', download: '下载', downloadAll: '两个都下载', remove: '删除', cancel: '取消',
  installed: '已安装', downloaded: '已下载', notInstalled: '未安装', notDownloaded: '未下载', failed: '失败',
  waiting: '等待引擎安装', withFirstModel: '下载第一个模型时一起安装',
  unsupported: (platform: string) => `不支持这台服务器（${platform}）`,
  network: (host: string) => `无法连接 ${host}`, checksum: (file: string) => `${file} 校验不通过`, engineFailed: '识别引擎没能装上',
  zipformer: '流式 Zipformer', sensevoice: 'SenseVoice',
  zipformerDetail: '边说边出字，只按停顿加标点 · 中文、英文',
  sensevoiceDetail: '每句说完出字，带标点，更准 · 中文、英文、日文、韩文、粤语',
  modelsFooter: '建议两个都装：边说边出字，每句说完由 SenseVoice 校正。',
  removeModel: (name: string) => `删除 ${name}？`, removeModelDetail: '之后可以重新下载。',
  removeEngine: '删除识别引擎？', removeEngineDetail: '重新安装之前本机识别不可用，模型保留。',
};
type Words = typeof EN;

function bytes(value: number): string {
  if (value < 1024 ** 3) return `${Math.max(1, Math.round(value / 1024 ** 2))} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function describe(failure: InstallError, words: Words): string {
  switch (failure.code) {
    case 'network': return words.network(failure.host);
    case 'checksum': return words.checksum(failure.file);
    case 'engine': return words.engineFailed;
    default: return failure.detail;
  }
}

export function speechLocalPage(installer: Installer): PluginPageProvider {
  const sizes = Object.fromEntries(MODELS.map(pin => [pin.id, pin.files.reduce((sum, file) => sum + file.bytes, 0)])) as Record<ModelId, number>;

  const button = (kind: InstallKind, name: string, label: string, extra: Partial<PluginPageButton> = {}): PluginPageButton =>
    ({ action: `${kind === 'engine' ? 'engine' : 'model'}.${name}`, label, ...(kind === 'engine' ? {} : { item: kind }), ...extra });

  /** A download under way, as a meter: what has arrived of what is coming, or what it waits for. */
  function meter(kind: InstallKind, label: string, detail: string | undefined, words: Words): PluginPageItem | undefined {
    const task = installer.progress(kind);
    if (!task) return undefined;
    const percent = task.total > 0 ? Math.min(99, (task.received / task.total) * 100) : 0;
    return {
      kind: 'meter', id: kind, label, sense: 'progress', percent, ...(detail ? { detail } : {}),
      value: task.waiting ? words.waiting : `${bytes(task.received)} / ${bytes(task.total)}`,
      buttons: [button(kind, 'cancel', words.cancel)],
    };
  }

  return {
    async read({ locale }): Promise<PluginPage> {
      const words = locale.toLowerCase().startsWith('zh') ? ZH : EN;
      const platform = enginePlatform();
      const supported = !('unsupported' in platform);

      const models: PluginPageItem[] = [];
      let missing = 0;
      for (const pin of MODELS) {
        const name = words[pin.id];
        const about = `${pin.id === 'zipformer' ? words.zipformerDetail : words.sensevoiceDetail} · ${bytes(sizes[pin.id])}`;
        const running = meter(pin.id, name, about, words);
        if (running) { models.push(running); continue; }
        const installed = await installer.modelInstalled(pin.id);
        if (!installed) missing++;
        const failure = installer.failure(pin.id);
        models.push({
          kind: 'row', id: pin.id, label: name,
          value: installed ? words.downloaded : failure ? words.failed : words.notDownloaded,
          detail: failure && !installed ? describe(failure, words) : about,
          buttons: installed
            ? [button(pin.id, 'delete', words.remove, { destructive: true, confirm: words.removeModel(name), confirmDetail: words.removeModelDetail })]
            : supported ? [button(pin.id, 'download', words.download)] : [],
        });
      }
      // Nothing yet and nothing coming: the recommended pair in one press.
      if (supported && missing === MODELS.length) models.push({ kind: 'buttons', buttons: [{ action: 'model.downloadAll', label: `${words.downloadAll} · ${bytes(MODELS.reduce((sum, pin) => sum + sizes[pin.id], 0))}` }] });

      let engine: PluginPageItem;
      if (!supported) engine = { kind: 'row', id: 'engine', label: words.engineName, value: words.unsupported(platform.unsupported) };
      else {
        const about = `sherpa-onnx ${ENGINE_VERSION}`;
        const running = meter('engine', words.engineName, about, words);
        const failure = installer.failure('engine');
        engine = running ?? (await installer.engineInstalled()
          ? { kind: 'row', id: 'engine', label: words.engineName, value: words.installed, detail: `${about} · ${bytes(await installer.diskSize('engine'))}`,
              buttons: [button('engine', 'delete', words.remove, { destructive: true, confirm: words.removeEngine, confirmDetail: words.removeEngineDetail })] }
          : { kind: 'row', id: 'engine', label: words.engineName, value: failure ? words.failed : words.notInstalled, detail: failure ? describe(failure, words) : words.withFirstModel,
              buttons: [button('engine', 'install', words.install)] });
      }

      return {
        sections: [
          // The page's tab is already called 模型.
          { id: 'models', footer: words.modelsFooter, items: models },
          { id: 'engine', title: words.engine, items: [engine] },
        ],
        refreshMs: installer.busy() ? 1000 : undefined,
      };
    },
    async run(_context, action, item) {
      if (action === 'engine.install') installer.start('engine');
      else if (action === 'engine.delete') await installer.remove('engine');
      else if (action === 'engine.cancel') installer.cancel('engine');
      else if (action === 'model.downloadAll') { for (const pin of MODELS) if (!await installer.modelInstalled(pin.id)) installer.start(pin.id); }
      else {
        const pin = MODELS.find(model => model.id === item);
        if (!pin) return;
        if (action === 'model.download') installer.start(pin.id);
        else if (action === 'model.delete') await installer.remove(pin.id);
        else if (action === 'model.cancel') installer.cancel(pin.id);
      }
    },
  };
}
