import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { isApplePlatform } from '@/lib/platform';

/** `⌥W` on Apple platforms, `Alt+W` elsewhere. */
export const altShortcut = (key: string): string => isApplePlatform ? `⌥${key}` : `Alt+${key}`;

/** The ⌥ (Alt) shortcuts the workbench answers while session tabs are on, as key caps; `use-global-shortcuts.ts` implements them. */
export const tabShortcuts: readonly { label: MessageDescriptor; keys: readonly string[] }[] = [
  { label: msg`切换到第 1–8 个标签`, keys: ['1–8'] },
  { label: msg`最后一个标签`, keys: ['9'] },
  { label: msg`上一个标签`, keys: ['['] },
  { label: msg`下一个标签`, keys: [']'] },
  { label: msg`关闭标签`, keys: ['W'] },
  { label: msg`重新打开关闭的标签`, keys: ['⇧', 'T'] },
  { label: msg`新会话`, keys: ['T'] },
  { label: msg`会话信息`, keys: ['I'] },
  { label: msg`切换视图`, keys: ['⇧', '1–3'] },
];

/** The caps for one entry: the platform's ⌥ or Alt first; Shift reads as a word where ⌥ does. */
export const shortcutCaps = (keys: readonly string[]): string[] => [isApplePlatform ? '⌥' : 'Alt', ...keys.map((key) => !isApplePlatform && key === '⇧' ? 'Shift' : key)];
