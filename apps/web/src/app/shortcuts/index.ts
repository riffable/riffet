/*
 * The web's view of the shared shortcut table (`packages/contracts/src/shortcuts.ts`): the chords in force
 * on this platform (the user's override, else the default), matching of key presses against them, key caps
 * for every place that shows a shortcut, and the conflict checks behind recording. Handlers ask
 * `matches(event, id)`; nothing outside the table writes a chord.
 */
import { RESERVED_CHORDS, SHORTCUTS, type ShortcutDefaults, type ShortcutId, type ShortcutOverrides, type ShortcutScope } from '@contracts';
import { isApplePlatform } from '@/lib/platform';
import { isComposingKey } from '../session/composerKeyboard';
import { chordOf, keybindingCaps, parseKeybinding } from './chords';
import { getShortcutOverrides, saveShortcutOverrides, useShortcutOverrides } from './overrides';

export { useShortcutOverrides } from './overrides';
export { recordedBinding, keybindingCaps } from './chords';

export type WebShortcutId = Extract<typeof SHORTCUTS[number], { defaults: { web: unknown } }>['id'];

export interface WebShortcut {
  id: WebShortcutId;
  scope: ShortcutScope;
  /** False for a family of keys (tab 1–9, view 1–3): listed, never rebound. */
  customizable: boolean;
  defaults: { apple: readonly string[]; other: readonly string[] };
}

/** The shortcuts the web offers, in the table's order. */
export const webShortcuts: readonly WebShortcut[] = SHORTCUTS.flatMap((shortcut) => {
  const web = (shortcut.defaults as ShortcutDefaults).web;
  return web ? [{ id: shortcut.id as WebShortcutId, scope: shortcut.scope, customizable: shortcut.customizable, defaults: web }] : [];
});
const byId: ReadonlyMap<ShortcutId, WebShortcut> = new Map(webShortcuts.map((shortcut) => [shortcut.id, shortcut]));

/** The chords in force for one shortcut, as written (`Mod+K`); empty when the user turned it off. */
export function effectiveBindings(id: ShortcutId, overrides: ShortcutOverrides = getShortcutOverrides(), apple = isApplePlatform): readonly string[] {
  const shortcut = byId.get(id);
  if (!shortcut) return [];
  return (shortcut.customizable ? overrides[id] : undefined) ?? shortcut.defaults[apple ? 'apple' : 'other'];
}

const parsedOf = (bindings: readonly string[], apple: boolean) => bindings.flatMap((binding) => parseKeybinding(binding, apple) ?? []);

let cached: { overrides: ShortcutOverrides; table: ReadonlyMap<ShortcutId, readonly string[]> } | undefined;
/** Parsed chords per id for this platform and the current overrides, rebuilt only when they change. */
function currentTable(): ReadonlyMap<ShortcutId, readonly string[]> {
  const overrides = getShortcutOverrides();
  if (cached?.overrides !== overrides) cached = { overrides, table: new Map(webShortcuts.map((shortcut) => [shortcut.id, parsedOf(effectiveBindings(shortcut.id, overrides), isApplePlatform)])) };
  return cached.table;
}

/** While a shortcut is being recorded the key presses belong to the recorder. Returns the release. */
let suspended = 0;
export function suspendShortcuts(): () => void {
  suspended += 1;
  let released = false;
  return () => { if (!released) { released = true; suspended -= 1; } };
}
export const shortcutsSuspended = (): boolean => suspended > 0;

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

/**
 * Whether the press is the workbench's to answer here: not during IME composition or recording, and not
 * where the focused thing owns the key. The terminal keeps ⌥ (Meta in the shell) and, for chords with Ctrl
 * (kill-line, the tmux prefix), Ctrl, except the key that opens it. On a Mac a text field that types with ⌥
 * keeps its characters (⌥5–9 are [ ] | { } on German and Nordic layouts) and its dead keys (⌥I is ˆ).
 */
function claimable(event: KeyboardEvent, id: ShortcutId): boolean {
  if (suspended || isComposingKey(event)) return false;
  const target = event.target;
  if (target instanceof Element && target.closest('.xterm') && (event.altKey || (event.ctrlKey && id !== 'toggleTerminal'))) return false;
  if (isApplePlatform && event.altKey && editable(target) && (event.key === 'Dead' || /^[\x20-\x7e]$/.test(event.key))) return false;
  return true;
}

/** Which of the shortcut's chords the press is (tab 1–8, view 1–3 are one chord each), or -1. */
export function matchIndex(event: KeyboardEvent, id: WebShortcutId): number {
  const index = currentTable().get(id)?.indexOf(chordOf(event)) ?? -1;
  return index >= 0 && claimable(event, id) ? index : -1;
}

export const matches = (event: KeyboardEvent, id: WebShortcutId): boolean => matchIndex(event, id) >= 0;

const joinCaps = (caps: readonly string[], apple: boolean) => caps.join(apple ? '' : '+');

/** Key caps of one chord of a shortcut (`['⌘', 'K']`), or none when it is off. */
export function shortcutCaps(id: ShortcutId, index = 0, overrides?: ShortcutOverrides): string[] {
  const binding = effectiveBindings(id, overrides)[index];
  return binding ? keybindingCaps(binding, isApplePlatform) : [];
}

/** The caps of a family of keys as one row reads them: the shared modifiers and the range of the last key (`⌥1–8`). */
export function familyCaps(id: ShortcutId, overrides?: ShortcutOverrides): string[] {
  const bindings = effectiveBindings(id, overrides);
  const first = shortcutCaps(id, 0, overrides);
  const last = shortcutCaps(id, bindings.length - 1, overrides);
  if (bindings.length < 2 || !first.length) return first;
  return [...first.slice(0, -1), `${first.at(-1)}–${last.at(-1)}`];
}

/** `⌘K` on Apple platforms, `Ctrl+K` elsewhere, for a `Tip` or a line of text; `undefined` when the shortcut is off. */
export function shortcutHint(id: ShortcutId, index = 0, overrides?: ShortcutOverrides): string | undefined {
  const caps = shortcutCaps(id, index, overrides);
  return caps.length ? joinCaps(caps, isApplePlatform) : undefined;
}

/** `shortcutHint` that renders again when the user rebinds. */
export function useShortcutHint(id: ShortcutId, index = 0): string | undefined {
  return shortcutHint(id, index, useShortcutOverrides());
}

export type ChordConflict = { kind: 'reserved' } | { kind: 'shortcut'; id: WebShortcutId; customizable: boolean };

/** What stops `binding` from becoming a chord of `id`: a chord the browser owns, or another shortcut's. */
export function findConflict(binding: string, id: ShortcutId, overrides: ShortcutOverrides = getShortcutOverrides(), apple = isApplePlatform): ChordConflict | undefined {
  const chord = parseKeybinding(binding, apple);
  if (!chord) return undefined;
  if (parsedOf(RESERVED_CHORDS.web, apple).includes(chord)) return { kind: 'reserved' };
  for (const other of webShortcuts) {
    if (other.id !== id && parsedOf(effectiveBindings(other.id, overrides, apple), apple).includes(chord)) return { kind: 'shortcut', id: other.id, customizable: other.customizable };
  }
  return undefined;
}

/** Every chord a plugin command may not take: the ones in force for the workbench's shortcuts, and the browser's. */
export function hostChordBindings(apple: boolean, overrides: ShortcutOverrides = getShortcutOverrides()): readonly string[] {
  return [...webShortcuts.flatMap((shortcut) => effectiveBindings(shortcut.id, overrides, apple)), ...RESERVED_CHORDS.web];
}

/** The overrides with `id` bound to `bindings` (none turns it off); a set equal to the default removes the override. */
export function withBindings(overrides: ShortcutOverrides, id: WebShortcutId, bindings: readonly string[], apple = isApplePlatform): ShortcutOverrides {
  const shortcut = byId.get(id);
  if (!shortcut?.customizable) return overrides;
  const next: Record<string, readonly string[]> = { ...overrides };
  const defaults = parsedOf(shortcut.defaults[apple ? 'apple' : 'other'], apple);
  const wanted = parsedOf(bindings, apple);
  if (wanted.length === defaults.length && wanted.every((chord, index) => chord === defaults[index])) delete next[id];
  else next[id] = bindings;
  return next as ShortcutOverrides;
}

/** Binds `id` to `binding`; `takeFrom` is the shortcut that holds it now and loses it. */
export function setBinding(id: WebShortcutId, binding: string, takeFrom?: WebShortcutId, apple = isApplePlatform): void {
  let next = getShortcutOverrides();
  const chord = parseKeybinding(binding, apple);
  if (takeFrom) next = withBindings(next, takeFrom, effectiveBindings(takeFrom, next, apple).filter((existing) => parseKeybinding(existing, apple) !== chord), apple);
  saveShortcutOverrides(withBindings(next, id, [binding], apple));
}

export const turnOff = (id: WebShortcutId): void => saveShortcutOverrides(withBindings(getShortcutOverrides(), id, []));
export const resetBinding = (id: WebShortcutId): void => { const next = { ...getShortcutOverrides() }; delete next[id]; saveShortcutOverrides(next); };
export const resetAllBindings = (): void => saveShortcutOverrides({});
