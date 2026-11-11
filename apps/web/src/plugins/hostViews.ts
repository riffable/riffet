import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ViewEntry } from './catalog';

/**
 * The views the app itself provides, under the short ids layouts and stored preferences use. Their
 * layouts draw them: a session shows the conversation or its terminal, the side panel shows files
 * or changes. Titles are read at call time so a language switch renames them.
 */
export function hostViews(): ViewEntry[] {
  return [
    { id: 'chat', location: 'session-view', title: i18n._(msg({ message: '对话', context: 'session-view' })), icon: 'messages-square', instances: 'per-session' },
    { id: 'terminal', location: 'session-view', title: i18n._(msg({ message: '终端', context: 'session-view' })), icon: 'square-terminal', instances: 'per-session' },
    { id: 'changes', location: 'sidebar', title: i18n._(msg`变更`), icon: 'git-compare', instances: 'per-project', when: { capability: 'git' } },
    { id: 'files', location: 'sidebar', title: i18n._(msg({ message: '文件', context: 'panels-files-tab' })), icon: 'folder', instances: 'per-project' },
  ];
}
