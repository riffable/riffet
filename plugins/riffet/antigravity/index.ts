import { PLUGIN_API_VERSION, type DoctorCheck, type Plugin, type PluginHost } from '@riffet/plugin-api';
import { cliCheck, resolveCliExecutable, runProcess } from '@riffet/plugin-api/kit';
import { AntigravityBackend } from './backend.js';

async function doctorChecks(host: PluginHost, versions: AntigravityBackend['cliVersions']): Promise<DoctorCheck[]> {
  const commands = ['agy'];
  let note = '';
  try {
    for (const profile of host.agentProfiles?.('antigravity') ?? []) {
      const executable =
        typeof profile.config.executable === 'string'
          ? profile.config.executable.trim()
          : typeof profile.config.cliPath === 'string'
            ? profile.config.cliPath.trim()
            : '';
      if (executable) commands.push(resolveCliExecutable({ command: executable }).executable);
    }
  } catch {
    note = '; saved profiles could not be read';
  }
  return [
    await cliCheck({
      id: 'antigravity',
      name: 'Antigravity CLI',
      commands,
      note,
      versions,
      install: 'Install the Antigravity CLI (`agy`), or configure its executable path in Settings → Models → Antigravity.',
      readVersion: async executable => {
        const result = await runProcess(executable, ['--version'], {
          cwd: process.cwd(),
          timeoutMs: 5000,
          maxOutputBytes: 4096,
        }).catch(() => undefined);
        if (result?.code !== 0) return undefined;
        return result.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? (result.stdout.trim() || undefined);
      },
    }),
  ];
}

export const antigravity: Plugin = {
  manifest: {
    id: 'riffet.antigravity',
    vendor: 'riffet',
    name: 'antigravity',
    apiVersion: PLUGIN_API_VERSION,
    defaultEnabled: true,
    version: '0.1.0',
    title: { en: 'Antigravity', 'zh-Hans': 'Antigravity' },
    description: { 'zh-Hans': '运行 Antigravity Agent 会话，管理模型提供商与 CLI。', en: 'Run Antigravity Agent sessions and manage model providers and the CLI.' },
    contributes: { agentBackends: [{ id: 'antigravity', title: { en: 'Antigravity', 'zh-Hans': 'Antigravity' } }] },
  },
  async activate(host) {
    const backend = new AntigravityBackend({ stateDir: await host.stateDir() });
    return {
      agentBackends: [backend],
      doctorChecks: () => doctorChecks(host, backend.cliVersions),
      dispose: () => backend.close(),
    };
  },
};
