// The plugin's page: the tools the builds need and the devices adb sees. Artifacts and per-project
// build state are not listed: the plugin reads a project only inside a task call, never from here.

import type { PluginHost, PluginPage, PluginPageProvider, PluginStatus } from '@riffet/plugin-api';
import { listDevices, type AdbDevice } from './devices.js';

const EN = {
  tools: 'Tools', devices: 'Devices', missing: 'Not found',
  connectedDevices: 'Connected devices', none: 'None', connected: 'Connected', unauthorized: 'Not authorized', offline: 'Offline', other: 'Unavailable',
};
const ZH: typeof EN = {
  tools: '工具', devices: '设备', missing: '未找到',
  connectedDevices: '已连接的设备', none: '无', connected: '已连接', unauthorized: '未授权', offline: '离线', other: '不可用',
};

const MAX_DEVICES = 8;

interface Device extends AdbDevice { name?: string; android?: string }

/** Missing build tools, by name. The Android SDK itself is Gradle's to find, so it is not checked here. */
export function missingTools(host: PluginHost): string[] {
  const missing: string[] = [];
  if (!host.resolveCli('adb')) missing.push('adb');
  if (!host.resolveCli('java') && !process.env.JAVA_HOME) missing.push('JDK');
  return missing;
}

export async function status(host: PluginHost): Promise<PluginStatus> {
  const missing = missingTools(host);
  // `status()` has no client locale, so the localized detail is the page's 工具 section, shown only when something is missing.
  return missing.length ? { state: 'attention' } : { state: 'ready' };
}

/** The listed devices with model and Android version for the ready ones; `listDevices` already caches adb's answer. */
async function devices(host: PluginHost): Promise<Device[]> {
  const adb = host.resolveCli('adb');
  const found = (await listDevices(host)).slice(0, MAX_DEVICES);
  if (!adb) return found;
  const cwd = await host.stateDir();
  return Promise.all(found.map(async (device): Promise<Device> => {
    if (device.state !== 'device') return device;
    const props = await host.runProcess(adb, ['-s', device.serial, 'shell', 'getprop ro.product.model; getprop ro.build.version.release'], { cwd, timeoutMs: 3000, maxOutputBytes: 4096 }).catch(() => undefined);
    const [name, android] = (props?.code === 0 ? props.stdout : '').split(/\r?\n/).map(text => text.trim());
    return { ...device, ...(name ? { name } : {}), ...(android ? { android } : {}) };
  }));
}

export function androidPage(host: PluginHost): PluginPageProvider {
  return {
    async read({ locale }): Promise<PluginPage> {
      const t = locale.toLowerCase().startsWith('zh') ? ZH : EN;
      const list = await devices(host);
      const state = (value: string): string => (value === 'device' ? t.connected : value === 'unauthorized' ? t.unauthorized : value === 'offline' ? t.offline : t.other);
      const missing = missingTools(host);
      return {
        sections: [
          ...(missing.length ? [{ id: 'tools', title: t.tools, items: missing.map(name => ({ kind: 'row' as const, id: name, label: name, value: t.missing })) }] : []),
          {
            id: 'devices', title: t.devices,
            items: list.length
              ? list.map(device => ({
                kind: 'row' as const, id: device.serial, label: device.name ?? device.serial,
                value: [state(device.state), device.android ? `Android ${device.android}` : ''].filter(Boolean).join(' · '),
                ...(device.name ? { detail: device.serial } : {}),
              }))
              : [{ kind: 'row' as const, id: 'none', label: t.connectedDevices, value: t.none }],
          },
        ],
      };
    },
  };
}
