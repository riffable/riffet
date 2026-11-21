import { lazy } from 'react';
import { defineWebPlugin } from '@riffet/plugin-web';

// The entry is read as soon as the plugin is on, so it stays small: the view is its own chunk.
const TraceView = lazy(() => import('./TraceView'));

export default defineWebPlugin({
  views: { 'riffet.trace/trace': TraceView },
  icons: { 'riffet.trace/trace': 'activity' },
  access: { requests: ['/api/sessions/*/trace'] },
});
