/*
 * Keyboard shortcuts of plugin commands (docs/design/plugin-system.md §4.3). A plugin only declares a
 * default; it is registered when no shortcut of the workbench (as the user has bound them) and no earlier
 * plugin holds it. The chord syntax is `shortcuts/chords.ts`.
 */

import type { ShortcutOverrides } from '@contracts';
import { chordOf, keybindingCaps, parseKeybinding } from './shortcuts/chords';
import { hostChordBindings } from './shortcuts';

export { chordOf, keybindingCaps, parseKeybinding };

/** What the workbench itself answers or keeps for the browser, as chords. */
function hostChords(apple: boolean, overrides?: ShortcutOverrides): ReadonlySet<string> {
  return new Set(hostChordBindings(apple, overrides).flatMap((key) => parseKeybinding(key, apple) ?? []));
}

export interface KeybindingRejection { id: string; keybinding: string; reason: 'invalid' | 'host' | 'plugin' }

/**
 * The chords to listen for, each with the command it runs, from the commands of the enabled plugins in order.
 * A binding that is not a usable chord, that the workbench holds, or that an earlier command holds is
 * left out and reported, so the caller can log why a plugin's shortcut does nothing.
 */
export function registerKeybindings(commands: readonly { id: string; keybinding?: string | undefined }[], apple: boolean, overrides?: ShortcutOverrides): { chords: Map<string, string>; rejected: KeybindingRejection[] } {
  const host = hostChords(apple, overrides);
  const chords = new Map<string, string>();
  const rejected: KeybindingRejection[] = [];
  for (const { id, keybinding } of commands) {
    if (!keybinding) continue;
    const parsed = parseKeybinding(keybinding, apple);
    if (!parsed) rejected.push({ id, keybinding, reason: 'invalid' });
    else if (host.has(parsed)) rejected.push({ id, keybinding, reason: 'host' });
    else if (chords.has(parsed)) rejected.push({ id, keybinding, reason: 'plugin' });
    else chords.set(parsed, id);
  }
  return { chords, rejected };
}
