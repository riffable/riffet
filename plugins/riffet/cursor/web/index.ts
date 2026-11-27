import { lazy } from 'react';
import { defineWebPlugin } from '@riffet/plugin-web';

// Cursor's page of the settings dialog. The entry is read as soon as the plugin is on, so it stays small:
// the page is a separate chunk that loads when it is first opened. Its providers are the shared list's.
const CliPage = lazy(() => import('./CliPage'));

export default defineWebPlugin({
  views: { 'riffet.cursor/cli': CliPage },
  icons: { 'riffet.cursor/cli': 'wrench' },
  // The compat endpoints Cursor's settings keep: the CLI's report, its models, its command runner, and the settings it owns.
  access: { requests: ['/api/cursor/'], settings: ['cursorCli', 'defaultModel'] },
});
