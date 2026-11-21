import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { webShortcuts, type WebShortcut, type WebShortcutId } from './shortcuts';

/*
 * Names and grouping of the shortcuts of the table (`packages/contracts/src/shortcuts.ts`). The keys are
 * not here: settings, the design page, tooltips and the plugin deny-list read the chords in force from
 * `shortcuts/`, so a rebinding shows up everywhere. Add an action to the table, then name it here.
 */

export type ShortcutGroup = 'workbench' | 'tabs' | 'session' | 'files';

const labels: Record<WebShortcutId, MessageDescriptor> = {
  search: msg`搜索会话`,
  commandPalette: msg`命令面板`,
  toggleSidebar: msg`侧栏`,
  toggleTerminal: msg`终端`,
  newSession: msg`新会话`,
  tabGoTo: msg`切换到第 1–8 个标签`,
  tabLast: msg`最后一个标签`,
  tabPrevious: msg`上一个标签`,
  tabNext: msg`下一个标签`,
  tabClose: msg`关闭标签`,
  tabReopen: msg`重新打开关闭的标签`,
  sessionInfo: msg`会话信息`,
  switchView: msg`切换视图`,
  find: msg`会话内查找`,
  quickOpen: msg`搜索文件`,
};

export interface HostShortcut extends WebShortcut {
  group: ShortcutGroup;
  label: MessageDescriptor;
}

export const hostShortcuts: readonly HostShortcut[] = webShortcuts.map((shortcut) => ({ ...shortcut, group: shortcut.scope as ShortcutGroup, label: labels[shortcut.id] }));

/** The groups in the order a list shows them, with their titles. */
export const shortcutGroups: readonly { group: ShortcutGroup; title: MessageDescriptor }[] = [
  { group: 'workbench', title: msg`工作台` },
  { group: 'tabs', title: msg`会话标签页` },
  { group: 'session', title: msg`会话` },
  { group: 'files', title: msg`文件` },
];

export const shortcutName = (id: WebShortcutId): MessageDescriptor => labels[id];
