import { lazy } from 'react';
import { defineWebPlugin } from '@riffet/plugin-web';

// The entry is read as soon as the plugin is on, so it stays small: the canvas itself is a separate
// chunk that loads when the view is first shown.
const CanvasView = lazy(() => import('./CanvasView'));

export default defineWebPlugin({
  views: { 'riffet.canvas/canvas': CanvasView },
  icons: { 'riffet.canvas/canvas': 'graph' },
});
