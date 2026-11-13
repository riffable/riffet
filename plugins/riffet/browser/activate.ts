// The browser plugin's server side, loaded once the plugin is on (index.ts). Everything it opens closes with the
// activation; the profiles stay on disk for the next one.

import type { ActivationScope, Contributions, PluginHost } from '@riffet/plugin-api';
import { Browsers } from './browsers.js';
import { describeChoice } from './engine.js';
import { liveChannel } from './live.js';
import { browserPage, type Installer } from './page.js';
import { BROWSER_TOOL_GROUP } from './protocol.js';
import { toolGroup } from './tools.js';

export async function activate(host: PluginHost, scope: ActivationScope): Promise<Contributions> {
  const stateDir = await host.stateDir();
  const browsers = new Browsers(host, stateDir);
  scope.onDispose(() => browsers.dispose());

  // `playwright-core install chromium-headless-shell` into the plugin's own directory. It runs on after the page's button returns.
  let installing: Promise<void> | undefined;
  let failure: string | undefined;
  const installer: Installer = {
    running: () => Boolean(installing),
    failure: () => failure,
    start() {
      if (installing || scope.signal.aborted) return;
      failure = undefined;
      installing = (async () => {
        try {
          const command = browsers.engine.installCommand();
          const outcome = await host.runProcess(command.file, command.args, { cwd: stateDir, env: command.env, timeoutMs: 20 * 60_000, maxOutputBytes: 256 * 1024 });
          if (outcome.code !== 0) failure = (outcome.stderr || outcome.stdout).trim().split('\n').at(-1)?.slice(0, 200) || (outcome.timedOut ? 'timed out' : `exit ${outcome.code}`);
        } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        finally { installing = undefined; }
      })();
    },
  };

  return {
    agentTools: { [BROWSER_TOOL_GROUP]: toolGroup(browsers, host) },
    channels: { 'riffet.browser/live': liveChannel(browsers, host) },
    page: browserPage(browsers, host, installer),
    async status() {
      const choice = browsers.choice;
      if (installing) return { state: 'attention', message: 'Downloading the browser…' };
      return browsers.installed() ? { state: 'ready', message: describeChoice(choice) } : { state: 'attention', message: choice.kind === 'bundled' ? 'Download the browser to use it' : `${describeChoice(choice)} was not found` };
    },
    async doctorChecks() {
      const choice = browsers.choice;
      const installed = browsers.installed();
      return [{
        id: 'browser', label: 'Browser', status: installed ? 'ok' : 'warn',
        detail: installed ? describeChoice(choice) : `${describeChoice(choice)} is not installed`,
        ...(installed ? {} : { fix: choice.kind === 'bundled' ? 'Plugins › Browser › Settings: download it' : 'Install it, or choose another browser in Plugins › Browser › Settings' }),
      }];
    },
  };
}
