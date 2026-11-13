/*
 * Keyboard shortcuts of plugin commands (docs/design/plugin-system.md §4.3). A plugin only declares a
 * default; it is registered when no shortcut of the workbench and no earlier plugin holds it.
 * A chord is `[ctrl+][alt+][shift+][meta+]<KeyboardEvent.code>`, so a layout that types other
 * characters with ⌥ still matches the key the plugin named.
 */

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
type Modifier = typeof MODIFIERS[number];

/** The characters a binding may name besides letters, digits and F1–F12, as `KeyboardEvent.code`. */
const KEY_CODES: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash',
};

const chord = (modifiers: ReadonlySet<Modifier>, code: string): string => [...MODIFIERS.filter((modifier) => modifiers.has(modifier)), code].join('+');

/**
 * The chord a declared binding such as `Mod+Shift+K` names (`Mod` is ⌘ on Apple platforms and Ctrl elsewhere), or
 * `undefined` for one that cannot be used: an unknown key or modifier, or no Ctrl, Alt or ⌘, which would fire while typing.
 */
export function parseKeybinding(text: string, apple: boolean): string | undefined {
  const parts = text.split('+').map((part) => part.trim());
  const key = parts.pop() ?? '';
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const name = part.toLowerCase();
    const modifier = name === 'mod' ? (apple ? 'meta' : 'ctrl')
      : name === 'ctrl' || name === 'control' ? 'ctrl'
        : name === 'alt' || name === 'option' ? 'alt'
          : name === 'shift' ? 'shift'
            : name === 'cmd' || name === 'command' || name === 'meta' ? 'meta' : undefined;
    if (!modifier) return undefined;
    modifiers.add(modifier);
  }
  if (!modifiers.has('ctrl') && !modifiers.has('alt') && !modifiers.has('meta')) return undefined;
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}`
    : /^[0-9]$/.test(key) ? `Digit${key}`
      : /^f([1-9]|1[0-2])$/i.test(key) ? key.toUpperCase()
        : KEY_CODES[key.toLowerCase()];
  return code ? chord(modifiers, code) : undefined;
}

/** A declared binding as key caps: the platform's glyph or word for each modifier, as the tab shortcuts in settings read. */
export function keybindingCaps(text: string, apple: boolean): string[] {
  return text.split('+').map((part) => part.trim()).filter(Boolean).map((part) => {
    const name = part.toLowerCase();
    if (name === 'mod') return apple ? '⌘' : 'Ctrl';
    if (name === 'cmd' || name === 'command' || name === 'meta') return apple ? '⌘' : 'Meta';
    if (name === 'ctrl' || name === 'control') return apple ? '⌃' : 'Ctrl';
    if (name === 'alt' || name === 'option') return apple ? '⌥' : 'Alt';
    if (name === 'shift') return apple ? '⇧' : 'Shift';
    return part.length === 1 ? part.toUpperCase() : part;
  });
}

/** The chord of a key press. */
export const chordOf = (event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>): string =>
  chord(new Set(MODIFIERS.filter((modifier) => event[`${modifier}Key`])), event.code);

/**
 * What the workbench itself answers: `use-global-shortcuts.ts` (search, commands, sidebar, dock, the ⌥ tab keys, 会话信息)
 * and the tab list in `tabs/keys.ts`, plus the browser's own ⌘/Ctrl keys for tabs and windows. Keep it in step with those.
 */
function hostChords(apple: boolean): ReadonlySet<string> {
  const keys = ['Mod+K', 'Mod+Shift+P', 'Mod+B', 'Ctrl+`', 'Alt+[', 'Alt+]', 'Alt+W', 'Alt+T', 'Alt+Shift+T', 'Alt+I'];
  for (const digit of '123456789') keys.push(`Alt+${digit}`, `Alt+Shift+${digit}`, `Mod+${digit}`);
  for (const letter of 'TWNQRL') keys.push(`Mod+${letter}`);
  return new Set(keys.map((key) => parseKeybinding(key, apple)!));
}

export interface KeybindingRejection { id: string; keybinding: string; reason: 'invalid' | 'host' | 'plugin' }

/**
 * The chords to listen for, each with the command it runs, from the commands of the enabled plugins in order.
 * A binding that is not a usable chord, that the workbench holds, or that an earlier command holds is
 * left out and reported, so the caller can log why a plugin's shortcut does nothing.
 */
export function registerKeybindings(commands: readonly { id: string; keybinding?: string | undefined }[], apple: boolean): { chords: Map<string, string>; rejected: KeybindingRejection[] } {
  const host = hostChords(apple);
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
