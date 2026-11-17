import manifest from './riffet-plugin.json';
// Android projects (docs/TASKS.md): finds the Gradle build and its application modules, then builds,
// installs and runs them, runs their tests and lint, and reads the device's crashes, screen and log.
// The host runs each task, keeps its log, cancels it and serves its files; the diagnostics point at
// the project's sources, crash frames included. The project's shared Android Studio run configurations
// are offered too. The commands start the same tasks from a palette.

import { type Plugin } from '@riffet/plugin-api';
import { configsProvider } from './configs.js';
import { workspaces } from './workspaces.js';
import { type ActionId, GRADLE_PROVIDER, LOGCAT_PROVIDER, gradleProvider, logcatProvider } from './gradle.js';

const COMMANDS: Record<string, { action: ActionId; provider: string }> = {
  'riffet.android/assemble-debug': { action: 'assemble', provider: GRADLE_PROVIDER },
  'riffet.android/run': { action: 'installRun', provider: GRADLE_PROVIDER },
  'riffet.android/open-logcat': { action: 'logcat', provider: LOGCAT_PROVIDER },
};

export const android: Plugin = {
  manifest: manifest as Plugin['manifest'],
  activate: host => ({
    services: { workspaces },
    taskProviders: [gradleProvider(host), logcatProvider(host), configsProvider(host)],
    commands: Object.fromEntries(Object.entries(COMMANDS).map(([id, { action, provider }]) => [id, {
      async run({ projectId, confirm }) {
        if (!projectId || !host.tasks) throw host.error('COMMAND_UNAVAILABLE', 'This command needs a project and the task service', 409);
        const task = await host.tasks.start(projectId, action, {}, { providerId: provider, ...(confirm ? { confirm } : {}) });
        return { kind: 'task', taskId: task.id };
      },
    }])),
  }),
};

export default android;
