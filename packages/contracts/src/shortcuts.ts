// The workbench's keyboard shortcuts, for every client that has them (docs/design/system/patterns.md §10).
// One entry is one action. Its default keys are written per client because each follows its platform:
// the browser owns ⌘/Ctrl with T, W, N and digits, so Web tabs use ⌥ (Alt); the Mac app owns its menus,
// so it uses the Mac's own conventions. Labels are the client's (Lingui on the web, the String Catalog on
// the Mac), looked up by `id`. Handlers, menus, the settings list, the plugin deny-list and conflict checks
// all read this table; a client never writes a chord of its own beside it.
//
// A chord is written as a plugin writes one: modifiers joined with `+`, then the key (`Mod+Shift+P`).
// `Mod` is ⌘ on Apple platforms and Ctrl elsewhere; `Cmd` is ⌘ only (the Mac). Keys are the US-layout
// key the physical key produces (`[`, `` ` ``, `1`), matched by `KeyboardEvent.code` on the web.

/** Where a shortcut acts: the whole app, the session tabs, the open session, the files panel, or (Mac) system-wide. */
export type ShortcutScope = 'workbench' | 'tabs' | 'session' | 'files' | 'global';

/**
 * Default chords per client. `web.apple` is a browser on macOS or iOS, `web.other` every other browser;
 * omitted on a client that does not offer the action. An empty list means "offered, unbound by default".
 */
export interface ShortcutDefaults {
  web?: { apple: readonly string[]; other: readonly string[] };
  mac?: readonly string[];
}

export interface ShortcutDefinition {
  id: string;
  scope: ShortcutScope;
  defaults: ShortcutDefaults;
  /**
   * False for a family of keys that is one rule rather than one action (tab 1–9, view 1–3): it is
   * listed, and its chords are taken, but it is not rebound key by key.
   */
  customizable: boolean;
}

const digits = (modifiers: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, index) => `${modifiers}+${from + index}`);
const both = (...chords: string[]) => ({ apple: chords, other: chords });

export const SHORTCUTS = [
  // Workbench
  { id: 'search', scope: 'workbench', customizable: true, defaults: { web: both('Mod+K'), mac: ['Cmd+K'] } },
  { id: 'commandPalette', scope: 'workbench', customizable: true, defaults: { web: both('Mod+Shift+P'), mac: ['Cmd+Shift+P'] } },
  { id: 'toggleSidebar', scope: 'workbench', customizable: true, defaults: { web: both('Mod+B'), mac: ['Cmd+B'] } },
  { id: 'toggleTerminal', scope: 'workbench', customizable: true, defaults: { web: both('Ctrl+`'), mac: ['Ctrl+`'] } },
  { id: 'newSession', scope: 'workbench', customizable: true, defaults: { web: both('Alt+T'), mac: ['Cmd+N'] } },
  { id: 'searchContent', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Shift+F'] } },
  { id: 'refresh', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+R'] } },
  { id: 'textBigger', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+='] } },
  { id: 'textSmaller', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+-'] } },
  { id: 'textReset', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+0'] } },
  { id: 'toggleInspector', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Alt+I'] } },
  { id: 'showChanges', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Alt+1'] } },
  { id: 'showFiles', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Alt+2'] } },
  { id: 'inspectorFullscreen', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Alt+F'] } },
  { id: 'openMarks', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Shift+L'] } },
  { id: 'openTasks', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Shift+J'] } },
  { id: 'openExtensions', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Shift+E'] } },
  { id: 'openStats', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Shift+U'] } },
  { id: 'previousSession', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Shift+['] } },
  { id: 'nextSession', scope: 'workbench', customizable: true, defaults: { mac: ['Cmd+Shift+]'] } },
  // Session tabs
  { id: 'tabGoTo', scope: 'tabs', customizable: false, defaults: { web: both(...digits('Alt', 1, 8)), mac: digits('Cmd', 1, 8) } },
  { id: 'tabLast', scope: 'tabs', customizable: false, defaults: { web: both('Alt+9'), mac: ['Cmd+9'] } },
  { id: 'tabPrevious', scope: 'tabs', customizable: true, defaults: { web: both('Alt+['), mac: ['Ctrl+Shift+Tab'] } },
  { id: 'tabNext', scope: 'tabs', customizable: true, defaults: { web: both('Alt+]'), mac: ['Ctrl+Tab'] } },
  { id: 'tabClose', scope: 'tabs', customizable: true, defaults: { web: both('Alt+W'), mac: ['Cmd+W'] } },
  { id: 'tabReopen', scope: 'tabs', customizable: true, defaults: { web: both('Alt+Shift+T'), mac: ['Cmd+Shift+T'] } },
  // The open session
  { id: 'sessionInfo', scope: 'session', customizable: true, defaults: { web: both('Alt+I') } },
  { id: 'switchView', scope: 'session', customizable: false, defaults: { web: both(...digits('Alt+Shift', 1, 3)) } },
  // Was ⇧⌘T while the tab bar was off, the same key as reopening a tab when it is on; one key, one action.
  { id: 'toggleChatTerminal', scope: 'session', customizable: true, defaults: { mac: ['Cmd+Alt+T'] } },
  { id: 'find', scope: 'session', customizable: true, defaults: { web: both('Mod+F'), mac: ['Cmd+F'] } },
  { id: 'findNext', scope: 'session', customizable: true, defaults: { mac: ['Cmd+G'] } },
  { id: 'findPrevious', scope: 'session', customizable: true, defaults: { mac: ['Cmd+Shift+G'] } },
  { id: 'interrupt', scope: 'session', customizable: true, defaults: { mac: ['Cmd+.'] } },
  { id: 'openInNewWindow', scope: 'session', customizable: true, defaults: { mac: ['Cmd+Alt+O'] } },
  // Files
  { id: 'quickOpen', scope: 'files', customizable: true, defaults: { web: both('Mod+P'), mac: ['Cmd+P'] } },
  // System-wide (Mac): the quick prompt. ⌃⌥Space is the system's "next input source"; ⌥⌘Space is Finder's search.
  { id: 'quickPrompt', scope: 'global', customizable: true, defaults: { mac: ['Alt+Space'] } },
] as const satisfies readonly ShortcutDefinition[];

export type ShortcutId = typeof SHORTCUTS[number]['id'];

/**
 * Chords a client keeps without answering them, so neither a user binding nor a plugin may take them.
 * Web: the browser's own ⌘/Ctrl keys for tabs and windows, the editing keys every text field and the files
 * panel answer (select all, copy, paste, cut, undo, redo, save), the composer's send keys, and ⌥⇧4–9 left
 * free for more views.
 * Mac: the system's and the standard menu items' (quit, hide, minimise, settings, edit, full screen), and the
 * composer's send keys.
 */
export const RESERVED_CHORDS = {
  web: [
    ...digits('Mod', 1, 9), ...[...'TWNQRL'].map((letter) => `Mod+${letter}`),
    ...[...'ACVXZS'].map((letter) => `Mod+${letter}`), 'Mod+Shift+Z', 'Mod+Enter', 'Mod+Shift+Enter',
    ...digits('Alt+Shift', 4, 9),
  ],
  mac: [
    'Cmd+Q', 'Cmd+H', 'Cmd+Alt+H', 'Cmd+M', 'Cmd+,', 'Cmd+A', 'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+Z', 'Cmd+Shift+Z',
    'Ctrl+Cmd+F', 'Cmd+S', 'Cmd+O', 'Cmd+Space', 'Cmd+Alt+Space', 'Ctrl+Space', 'Ctrl+Alt+Space', 'Cmd+Tab', 'Cmd+`',
    'Cmd+Enter', 'Cmd+Shift+Enter',
  ],
} as const;

/**
 * A user's own bindings on one device, keyed by shortcut id: the chords that replace the defaults, or an
 * empty list to turn the shortcut off. Ids not listed keep their defaults. Stored on the device (a
 * personal preference, docs/guide/multi-server.md class C), never on the server.
 */
export type ShortcutOverrides = Partial<Record<ShortcutId, readonly string[]>>;
