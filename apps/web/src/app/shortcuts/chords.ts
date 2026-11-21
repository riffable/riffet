/*
 * The chord syntax of the shortcut table (`packages/contracts/src/shortcuts.ts`) and of plugin keybindings:
 * `Mod+Shift+K`, parsed to `[ctrl+][alt+][shift+][meta+]<KeyboardEvent.code>` so a layout that types
 * other characters with ⌥ still matches the key that was named.
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

/** The name a chord text uses for a key code, the first one `KEY_CODES` lists for it. */
const KEY_NAMES: ReadonlyMap<string, string> = new Map(Object.entries(KEY_CODES).reverse().map(([name, code]) => [code, name.length > 1 ? name[0]!.toUpperCase() + name.slice(1) : name]));

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

const CAP_GLYPHS: Readonly<Record<string, string>> = { Enter: '↵', Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫', Delete: '⌦', Tab: '⇥' };

/** A declared binding as key caps: the platform's glyph or word for each modifier, as the tab shortcuts in settings read. */
export function keybindingCaps(text: string, apple: boolean): string[] {
  return text.split('+').map((part) => part.trim()).filter(Boolean).map((part) => {
    const name = part.toLowerCase();
    if (name === 'mod') return apple ? '⌘' : 'Ctrl';
    if (name === 'cmd' || name === 'command' || name === 'meta') return apple ? '⌘' : 'Meta';
    if (name === 'ctrl' || name === 'control') return apple ? '⌃' : 'Ctrl';
    if (name === 'alt' || name === 'option') return apple ? '⌥' : 'Alt';
    if (name === 'shift') return apple ? '⇧' : 'Shift';
    return (apple && CAP_GLYPHS[part]) || (part.length === 1 ? part.toUpperCase() : part);
  });
}

type KeyState = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>;

/** The chord of a key press. */
export const chordOf = (event: KeyState): string =>
  chord(new Set(MODIFIERS.filter((modifier) => event[`${modifier}Key`])), event.code);

/**
 * The binding text a key press records (`Mod+Alt+K`, in the form the table and plugins write), or
 * `undefined` when the press is not a usable chord: a bare modifier, an unnamed key, no Ctrl, Alt or
 * ⌘/Ctrl-as-`Mod`, or the Meta key on a platform where the browser does not give it to pages.
 */
export function recordedBinding(event: KeyState, apple: boolean): string | undefined {
  if (event.metaKey && !apple) return undefined;
  const key = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^F([1-9]|1[0-2])$/.test(event.code) ? event.code : undefined) ?? KEY_NAMES.get(event.code);
  if (!key || key === 'Escape') return undefined;
  const modifiers = [
    ...(apple ? (event.metaKey ? ['Mod'] : []) : event.ctrlKey ? ['Mod'] : []),
    ...(apple && event.ctrlKey ? ['Ctrl'] : []),
    ...(event.altKey ? ['Alt'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
  ];
  const text = [...modifiers, key].join('+');
  return parseKeybinding(text, apple) ? text : undefined;
}
