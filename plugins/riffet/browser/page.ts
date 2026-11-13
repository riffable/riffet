// The browser's page in the plugin's details (docs/PLUGIN_ARCHITECTURE.md「插件页」, docs/BROWSER.md §8): which
// browser runs, which sites need no confirmation or are refused, and each project's browsing data.

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { listSetting, type PluginHost, type PluginPage, type PluginPageItem, type PluginPageProvider } from '@riffet/plugin-api';
import type { Browsers } from './browsers.js';
import { browserChoice } from './engine.js';

type Words = Record<keyof typeof EN, string>;

const EN = {
  browser: 'Browser', bundled: 'Chromium, downloaded by Riffet', chrome: 'Google Chrome', msedge: 'Microsoft Edge', custom: 'Another browser',
  downloaded: 'Downloaded', notDownloaded: 'Not downloaded', downloading: 'Downloading…', found: 'Installed', notFound: 'Not found', download: 'Download',
  path: 'Path', pathPlaceholder: '/Applications/Chromium.app/Contents/MacOS/Chromium', pathMissing: 'Nothing at this path',
  sites: 'Sites', allow: 'No confirmation needed', block: 'Blocked', sitePlaceholder: 'example.com',
  sitesFooter: 'Payments are always left to you, and orders are always confirmed.',
  data: 'Browsing data', downloads: 'Downloaded files', none: 'No browsing data', clear: 'Clear', inUse: 'In use',
  clearProfile: 'Clear this project’s browsing data?', clearProfileDetail: 'Its sites will need signing in again.', clearDownloads: 'Delete the files the browser downloaded?',
  dataFooter: 'Kept per project on the server.', failed: 'Download failed',
};
const ZH: Words = {
  browser: '浏览器', bundled: 'Chromium（由 Riffet 下载）', chrome: 'Google Chrome', msedge: 'Microsoft Edge', custom: '其他浏览器',
  downloaded: '已下载', notDownloaded: '未下载', downloading: '正在下载…', found: '已安装', notFound: '未找到', download: '下载',
  path: '路径', pathPlaceholder: '/Applications/Chromium.app/Contents/MacOS/Chromium', pathMissing: '这个路径下没有文件',
  sites: '网站', allow: '无需确认', block: '禁止访问', sitePlaceholder: 'example.com',
  sitesFooter: '付款总由你完成，下单总会先确认。',
  data: '浏览数据', downloads: '下载的文件', none: '没有浏览数据', clear: '清除', inUse: '使用中',
  clearProfile: '清除这个项目的浏览数据？', clearProfileDetail: '其中的网站需要重新登录。', clearDownloads: '删除浏览器下载的文件？',
  dataFooter: '按项目分开保存在服务器上。', failed: '下载失败',
};

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export interface Installer {
  running(): boolean;
  /** The last download's failure, until the next one starts. */
  failure(): string | undefined;
  start(): void;
}

export function browserPage(browsers: Browsers, host: PluginHost, installer: Installer): PluginPageProvider {
  // Sizes walk whole profiles: read at most every few seconds (the page reads again after each change), and anew after a clear.
  let sizes: { at: number; value: Promise<{ profiles: Awaited<ReturnType<Browsers['profiles']>>; downloads: number }> } | undefined;
  const data = () => {
    if (!sizes || Date.now() - sizes.at > 5_000) sizes = { at: Date.now(), value: Promise.all([browsers.profiles(), browsers.downloadsSize()]).then(([profiles, downloads]) => ({ profiles, downloads })) };
    return sizes.value;
  };

  return {
    async read({ locale }): Promise<PluginPage> {
      const t = locale.toLowerCase().startsWith('zh') ? ZH : EN;
      const settings = host.settings();
      const choice = browserChoice(settings);
      const value = choice.kind === 'bundled' ? 'bundled' : choice.kind === 'channel' ? choice.channel : 'custom';
      const installing = installer.running();
      const bundled = browsers.engine.installed({ kind: 'bundled' });
      const failure = installer.failure();
      const channel = (id: 'chrome' | 'msedge') => {
        const found = browsers.engine.installed({ kind: 'channel', channel: id });
        return { value: id, label: t[id], detail: found ? t.found : t.notFound, ...(found || value === id ? {} : { disabled: true }) };
      };
      const browserItems: PluginPageItem[] = [{
        kind: 'choice', key: 'browser', label: t.browser, value,
        options: [
          {
            value: 'bundled', label: t.bundled,
            detail: installing ? t.downloading : bundled ? t.downloaded : failure ? `${t.failed}: ${failure}` : t.notDownloaded,
            ...(!bundled && !installing ? { button: { action: 'install', label: t.download } } : {}),
          },
          channel('chrome'),
          channel('msedge'),
          { value: 'custom', label: t.custom },
        ],
      }];
      if (choice.kind === 'path') {
        browserItems.push({ kind: 'text', key: 'executablePath', label: t.path, value: choice.path, placeholder: t.pathPlaceholder });
        if (choice.path && !existsSync(choice.path)) browserItems.push({ kind: 'row', id: 'path-missing', label: t.pathMissing });
      }

      const { profiles, downloads } = await data();
      const dataItems: PluginPageItem[] = profiles.sort((a, b) => b.bytes - a.bytes).map(profile => ({
        kind: 'row', id: `profile:${profile.name}`, label: profile.path ? basename(profile.path) : profile.name, value: bytes(profile.bytes),
        ...(profile.path ? { detail: profile.open ? `${profile.path} · ${t.inUse}` : profile.path } : profile.open ? { detail: t.inUse } : {}),
        buttons: [{ action: 'clear-profile', item: profile.name, label: t.clear, destructive: true, confirm: t.clearProfile, confirmDetail: t.clearProfileDetail }],
      }));
      if (downloads > 0) dataItems.push({ kind: 'row', id: 'downloads', label: t.downloads, value: bytes(downloads), buttons: [{ action: 'clear-downloads', label: t.clear, destructive: true, confirm: t.clearDownloads }] });
      if (!dataItems.length) dataItems.push({ kind: 'row', id: 'empty', label: t.none });

      return {
        sections: [
          { id: 'browser', title: t.browser, items: browserItems },
          {
            id: 'sites', title: t.sites, footer: t.sitesFooter, items: [
              { kind: 'list', key: 'allowSites', label: t.allow, values: listSetting(settings.allowSites), placeholder: t.sitePlaceholder },
              { kind: 'list', key: 'blockSites', label: t.block, values: listSetting(settings.blockSites), placeholder: t.sitePlaceholder },
            ],
          },
          { id: 'data', title: t.data, footer: t.dataFooter, items: dataItems },
        ],
        ...(installing ? { refreshMs: 1500 } : {}),
      };
    },

    async run(_context, action, item) {
      if (action === 'install') { installer.start(); return; }
      if (action === 'clear-profile' && item) { await browsers.clearProfile(item); sizes = undefined; return; }
      if (action === 'clear-downloads') { await browsers.clearDownloads(); sizes = undefined; return; }
      throw host.error('UNKNOWN_ACTION', `Unknown action ${action}`, 404);
    },
  };
}
