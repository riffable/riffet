import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';
import { AntigravityBackend } from './backend.js';

export const antigravity: Plugin = {
  manifest: {
    id: 'riffet.antigravity',
    vendor: 'riffet',
    name: 'antigravity',
    apiVersion: PLUGIN_API_VERSION,
    defaultEnabled: true,
    version: '0.1.0',
    title: { en: 'Antigravity', 'zh-Hans': 'Antigravity' },
    contributes: { agentBackends: [{ id: 'antigravity', title: { en: 'Antigravity', 'zh-Hans': 'Antigravity' } }] },
  },
  async activate(host) {
    const backend = new AntigravityBackend({ stateDir: await host.stateDir() });
    return { agentBackends: [backend], dispose: () => backend.close() };
  },
};
