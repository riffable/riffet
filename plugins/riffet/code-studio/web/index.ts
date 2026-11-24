import { lazy } from 'react';
import { defineWebPlugin } from '@riffet/plugin-web';

// The entry is read as soon as the plugin is on, so the page itself is a separate chunk.
const CodeStudio = lazy(() => import('./CodeStudio'));

export default defineWebPlugin({
  views: { 'riffet.code-studio/code-studio': CodeStudio },
  icons: { 'riffet.code-studio/code-studio': 'file-code' },
  access: { requests: ['/api/projects/*/files', '/api/projects/*/file', '/api/projects/*/find', '/api/projects/*/search', '/api/projects/*/code/', '/api/projects/*/git/head', '/api/projects/*/git/file', '/api/projects/*/git/blame', '/api/projects/*/git/commits/', '/api/projects/*/git/refs', '/api/projects/*/git/switch'] },
});
