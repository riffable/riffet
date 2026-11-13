// Cursor (cursor-agent): the first Agent Riffet had, provided as a plugin. The CLI keeps running in a
// terminal pane; the plugin follows its chat store, screen and hooks (docs/design/plugin-system.md §5.1).

import { basename, dirname } from 'node:path';
import { PLUGIN_API_VERSION, type DoctorCheck, type Plugin, type PluginHost } from '@riffet/plugin-api';
import { CursorBackend } from './backend.js';
import { cursorDoctorChecks } from './backend/doctor.js';
import { cursorLaunchProfileOf } from './cli-driver.js';
import { cursorCapabilityReport } from './config.js';

/** `riffet doctor`'s Cursor row, for the profile the user configured: the host hands over the profiles it keeps. */
async function doctorChecks(host: PluginHost): Promise<DoctorCheck[]> {
  const profiles = host.agentProfiles?.('cursor') ?? [];
  const config = (profiles.find(profile => profile.isDefault) ?? profiles[0])?.config ?? {};
  const capabilities = await cursorCapabilityReport(cursorLaunchProfileOf(config));
  return cursorDoctorChecks(() => host.agentProfiles?.('cursor').map(profile => typeof profile.config.executable === 'string' ? profile.config.executable : undefined) ?? [], capabilities);
}

/**
 * Compat: Riffet's own state directory. The hook plugin directory (`<state>/cursor-hook`) and the config-edit backups
 * (`<state>/config-backups`) were kept there before Cursor was a plugin: a CLI that outlives the server keeps calling its
 * hook script from the old directory, and the backup archive includes the backups. The plugin's private directory
 * is `<state>/plugin-data/<id>` (`PluginHost.stateDir`), which names it.
 */
export function legacyStateRoot(pluginDir: string): string {
  const root = dirname(dirname(pluginDir));
  return basename(dirname(pluginDir)) === 'plugin-data' ? root : pluginDir;
}

export const cursor: Plugin = {
  manifest: {
    id: 'riffet.cursor', vendor: 'riffet', name: 'cursor', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '0.1.0',
    title: { en: 'Cursor', 'zh-Hans': 'Cursor' },
    description: { 'zh-Hans': '运行 Cursor Agent 会话，管理提供商与 CLI。', en: 'Run Cursor Agent sessions and manage providers and the CLI.' },
    contributes: {
      agentBackends: [{ id: 'cursor', title: { en: 'Cursor', 'zh-Hans': 'Cursor' } }],
      // Pages of the settings dialog, reached from the Agent's row on the models page; the client entry is `web/`.
      views: [
        { id: 'riffet.cursor/provider', title: { 'zh-Hans': 'Cursor 提供商', en: 'Cursor Provider' }, locations: ['settings'], clients: ['web', 'macos'], instances: 'single' },
        { id: 'riffet.cursor/cli', title: { 'zh-Hans': 'CLI 管理', en: 'CLI Management' }, locations: ['settings'], clients: ['web', 'macos'], instances: 'single' },
      ],
    },
  },
  async activate(host) {
    const backend = new CursorBackend({ stateDir: legacyStateRoot(await host.stateDir()) });
    return {
      agentBackends: [backend],
      services: { usage: backend.usageService },
      doctorChecks: () => doctorChecks(host),
      // Reaps the unclaimed warm-ups and closes the watchers, timers and hook bridge; a session's CLI keeps running.
      dispose: () => backend.close(),
    };
  },
};
