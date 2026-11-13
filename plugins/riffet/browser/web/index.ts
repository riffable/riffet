import { lazy } from 'react';
import { defineWebPlugin } from '@riffet/plugin-web';

// The entry is read as soon as the plugin is on, so the panel itself is a separate chunk.
const BrowserPanel = lazy(() => import('./BrowserPanel'));

export default defineWebPlugin({
  views: { 'riffet.browser/panel': BrowserPanel },
  icons: { 'riffet.browser/panel': 'globe' },
});
