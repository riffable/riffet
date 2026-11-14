import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/*
 * The one list of the keys the workbench itself answers. Three things read it: the shortcut map of the
 * design page and settings (labels and key caps), and `pluginKeybindings.ts`, which refuses a plugin
 * command bound to any of these chords. The handlers stay where they act: `use-global-shortcuts.ts`
 * (every entry but the view keys) and `session/ViewDots.tsx` (⌥⇧1–3). Add a workbench shortcut here and in
 * its handler together.
 */

export interface HostShortcut {
  /** Where the map lists it: the workbench's own keys, or the ⌥ (Alt) keys of session tabs. */
  group: 'workbench' | 'tabs';
  label: MessageDescriptor;
  /** Key caps. `Mod` stands for ⌘ on Apple platforms and Ctrl elsewhere; tab entries leave out the leading ⌥ (Alt). */
  keys: readonly string[];
  /** The chords it takes, as a plugin would write them (`Mod+K`), one per key it answers. */
  chords: readonly string[];
}

const digits = (modifiers: string, from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, index) => `${modifiers}+${from + index}`);

export const hostShortcuts: readonly HostShortcut[] = [
  { group: 'workbench', label: msg`搜索会话`, keys: ['Mod', 'K'], chords: ['Mod+K'] },
  { group: 'workbench', label: msg`命令面板`, keys: ['Mod', '⇧', 'P'], chords: ['Mod+Shift+P'] },
  { group: 'workbench', label: msg`侧栏`, keys: ['Mod', 'B'], chords: ['Mod+B'] },
  { group: 'workbench', label: msg`终端`, keys: ['Ctrl', '`'], chords: ['Ctrl+`'] },
  { group: 'tabs', label: msg`切换到第 1–8 个标签`, keys: ['1–8'], chords: digits('Alt', 1, 8) },
  { group: 'tabs', label: msg`最后一个标签`, keys: ['9'], chords: ['Alt+9'] },
  { group: 'tabs', label: msg`上一个标签`, keys: ['['], chords: ['Alt+['] },
  { group: 'tabs', label: msg`下一个标签`, keys: [']'], chords: ['Alt+]'] },
  { group: 'tabs', label: msg`关闭标签`, keys: ['W'], chords: ['Alt+W'] },
  { group: 'tabs', label: msg`重新打开关闭的标签`, keys: ['⇧', 'T'], chords: ['Alt+Shift+T'] },
  { group: 'tabs', label: msg`新会话`, keys: ['T'], chords: ['Alt+T'] },
  { group: 'tabs', label: msg`会话信息`, keys: ['I'], chords: ['Alt+I'] },
  // Handled by `session/ViewDots.tsx`, which listens for the three keys itself.
  { group: 'tabs', label: msg`切换视图`, keys: ['⇧', '1–3'], chords: digits('Alt+Shift', 1, 3) },
];

/**
 * Chords the workbench keeps without answering them: the browser's ⌘/Ctrl keys for tabs and windows
 * (digits, T, W, N, Q, R, L), and ⌥⇧4–9, left free for more views.
 */
export const reservedChords: readonly string[] = [
  ...digits('Mod', 1, 9), ...[...'TWNQRL'].map((letter) => `Mod+${letter}`), ...digits('Alt+Shift', 4, 9),
];

/** Every chord a plugin command may not take, in the form `parseKeybinding` reads. */
export const hostChordBindings: readonly string[] = [...hostShortcuts.flatMap((shortcut) => shortcut.chords), ...reservedChords];
