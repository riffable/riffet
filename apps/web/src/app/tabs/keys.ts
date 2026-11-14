import type { MessageDescriptor } from '@lingui/core';
import { isApplePlatform } from '@/lib/platform';
import { hostShortcuts } from '../hostShortcuts';

/** `⌥W` on Apple platforms, `Alt+W` elsewhere. */
export const altShortcut = (key: string): string => isApplePlatform ? `⌥${key}` : `Alt+${key}`;

/** The ⌥ (Alt) shortcuts the workbench answers while session tabs are on, as key caps; the registry is `hostShortcuts.ts`. */
export const tabShortcuts: readonly { label: MessageDescriptor; keys: readonly string[] }[] = hostShortcuts.filter((shortcut) => shortcut.group === 'tabs');

/** The caps for one entry: the platform's ⌥ or Alt first; Shift reads as a word where ⌥ does. */
export const shortcutCaps = (keys: readonly string[]): string[] => [isApplePlatform ? '⌥' : 'Alt', ...keys.map((key) => !isApplePlatform && key === '⇧' ? 'Shift' : key)];
