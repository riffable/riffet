import { SHORTCUTS, type ShortcutId, type ShortcutOverrides } from '@contracts';
import { createStore, useStore } from '@/lib/store';
import { isApplePlatform } from '@/lib/platform';
import { readStored, writeStored } from '@/lib/utils';
import { parseKeybinding } from './chords';

/**
 * The user's own bindings, kept in this browser only (a personal preference, docs/guide/multi-server.md
 * class C): never on the server, never synced between devices. Other tabs of the browser follow through
 * the storage event.
 */
const KEY = 'riffet.shortcuts.v1';

const customizable: ReadonlySet<string> = new Set(SHORTCUTS.filter((shortcut) => shortcut.customizable && 'web' in shortcut.defaults).map((shortcut) => shortcut.id));

/** Rebuilds the overrides from storage; whatever is not a known, usable binding is dropped rather than throwing. */
export function parseOverrides(raw: string, apple: boolean): ShortcutOverrides {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Partial<Record<ShortcutId, readonly string[]>> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!customizable.has(id) || !Array.isArray(value)) continue;
    const chords = value.filter((chord): chord is string => typeof chord === 'string' && parseKeybinding(chord, apple) !== undefined);
    if (chords.length === value.length) result[id as ShortcutId] = chords;
  }
  return result;
}

interface OverridesState { overrides: ShortcutOverrides }

const store = createStore<OverridesState>({ overrides: parseOverrides(readStored(KEY), isApplePlatform) });

export const getShortcutOverrides = (): ShortcutOverrides => store.get().overrides;
export const useShortcutOverrides = (): ShortcutOverrides => useStore(store, (state) => state.overrides);

/** Saves the whole set; an empty set removes the key. */
export function saveShortcutOverrides(overrides: ShortcutOverrides): void {
  const clean = parseOverrides(JSON.stringify(overrides), isApplePlatform);
  writeStored(KEY, Object.keys(clean).length ? JSON.stringify(clean) : undefined);
  store.set({ overrides: clean });
}

function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  store.set({ overrides: parseOverrides(readStored(KEY), isApplePlatform) });
}

if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
import.meta.hot?.dispose(() => { window.removeEventListener('storage', onStorage); });
