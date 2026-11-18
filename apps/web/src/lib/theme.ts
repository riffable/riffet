/**
 * Two independent choices, not one.
 *
 * `mode` is light/dark/system — it decides *which half* of a palette is used and nothing else.
 * `themeId` picks *which palette*. Keeping them apart is what lets "follow the system" keep working
 * once there is more than one theme, and it is why `.dark` could stay the mode switch: every
 * `dark:` utility in the app keeps reading the same class it always did, while the palette is
 * selected by an attribute those utilities never mention.
 *
 * The theme id is kept as stored, including one that names a custom theme this device has not
 * fetched yet. Resolving it against the built-ins here would silently rewrite a shared choice back
 * to Riffet before the library had a chance to answer; only a *confirmed* fetch may dereference it.
 */

import { applyThemeAppearance, readShareAppearance } from './theme-palette';
import { useSyncExternalStore } from 'react';
import { isCustomCodeThemeId, isKnownCodeThemeId, resolveCodeThemeId, type ThemeAnsi } from '@contracts';
import { activePluginPalette, releasePluginPalette, subscribeAppearance, syncAppearance } from './appearance';
import { getDisplaySettings, subscribeDisplaySettings } from './display-settings';
import { createStore, useStore } from './store';
import { readStored, writeStored } from './utils';
import { DEFAULT_THEME_ID, canonicalThemeId, isKnownTheme, parseThemeMode, type ResolvedMode, type ThemeMode } from './themes';
import {
  customTheme, ensureCustomThemeCss, isCustomThemeId, subscribeThemeLibrary, syncThemeLibrary, themeLibrarySynced, themeOption, themeRevision,
} from './theme-library';

/** Re-exported so call sites keep importing the mode vocabulary from the runtime module. */
export type { ThemeMode, ResolvedMode };

const shareMode = import.meta.env.MODE === 'share';
const preview = shareMode && document.querySelector('meta[name="riffet-share-preview"]')?.getAttribute('content') === 'true';
const originalAppearance = shareMode ? readShareAppearance() : undefined;
const MODE_KEY = shareMode ? 'riffet.share.theme.mode' : 'riffet.theme';
const THEME_KEY = shareMode ? 'riffet.share.theme.id' : 'riffet.theme.id';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function readMode(): ThemeMode {
  if (shareMode) return parseThemeMode(preview ? originalAppearance?.mode : readStored(MODE_KEY) ?? originalAppearance?.mode);
  return parseThemeMode(readStored(MODE_KEY));
}

/**
 * Accepts a built-in id or anything that claims to be a custom one. The claim is checked against the
 * library later; rejecting it now would turn a not-yet-loaded theme into Riffet on every reload.
 */
function readThemeId(): string {
  const stored = shareMode ? (preview ? originalAppearance?.themeId : readStored(THEME_KEY) ?? originalAppearance?.themeId) : readStored(THEME_KEY);
  if (!stored) return DEFAULT_THEME_ID;
  const canonical = canonicalThemeId(stored) ?? stored;
  return isKnownTheme(canonical) || (shareMode ? Boolean(themeOption(canonical)) : isCustomThemeId(canonical)) ? canonical : DEFAULT_THEME_ID;
}

function resolveMode(mode: ThemeMode): ResolvedMode {
  return mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
}

const initialMode = readMode();
const store = createStore<{ mode: ThemeMode; themeId: string; resolved: ResolvedMode }>({ mode: initialMode, themeId: readThemeId(), resolved: resolveMode(initialMode) });

function resolveActiveCodeTheme(selection: string, activeUiId: string, plugin?: { key: string; hasSyntax?: boolean }): string {
  if (isKnownCodeThemeId(selection)) return selection;
  if (isCustomCodeThemeId(selection)) {
    const picked = customTheme(selection);
    if (picked?.syntax) return selection;
  }
  if (plugin?.hasSyntax) return plugin.key;
  if (!plugin && isCustomThemeId(activeUiId) && customTheme(activeUiId)?.syntax) return activeUiId;
  return resolveCodeThemeId('auto', plugin ? undefined : activeUiId);
}

function activeThemeId(themeId: string, plugin = activePluginPalette()): string {
  return plugin?.key ?? (isCustomThemeId(themeId) && !themeOption(themeId) ? DEFAULT_THEME_ID : themeId);
}

/**
 * Everything a theme change has to touch, in one place. The browser chrome colour is read back from
 * the applied `--bg` instead of being a hard-coded pair, so a new theme gets a matching toolbar
 * without anyone remembering to add one. Custom rules are injected first, because that read-back
 * cannot see a palette whose block is not in the document yet.
 */
function apply(): void {
  ensureCustomThemeCss();
  const { mode, themeId } = store.get();
  const resolved = resolveMode(mode);
  const plugin = activePluginPalette();
  const activeUiId = activeThemeId(themeId, plugin);
  const codeThemeId = resolveActiveCodeTheme(getDisplaySettings().codeTheme, activeUiId, plugin);
  // A plugin palette in effect is painted over the chosen theme; the stored choice stays beneath it.
  applyThemeAppearance(activeUiId, resolved, codeThemeId);
  store.set({ resolved });
}

function onSystemChange(): void {
  if (store.get().mode === 'system') apply();
}

/** Another tab, or this one after a sync, changed the shared library. */
function onLibraryChange(): void {
  // Only a fetch the server answered may say an id is gone. A device that has never synced keeps
  // showing its cached palette rather than being reset by a network failure.
  const { themeId } = store.get();
  if (themeId.startsWith('custom-') && themeLibrarySynced() && !themeOption(themeId)) {
    store.set({ themeId: DEFAULT_THEME_ID });
    writeStored(THEME_KEY, undefined);
  }
  apply();
}

function onStorageChange(event: StorageEvent): void {
  if (preview) return;
  if (event.key !== MODE_KEY && event.key !== THEME_KEY && event.key !== null) return;
  try {
    if (event.storageArea !== window.localStorage) return;
  } catch { return; }
  // Read the latest values rather than an older event's payload. Another tab may have changed them
  // again before this event was delivered; never write them back here.
  store.set({ mode: readMode(), themeId: readThemeId() });
  apply();
}

media.addEventListener('change', onSystemChange);
window.addEventListener('storage', onStorageChange);
const unsubscribeLibrary = subscribeThemeLibrary(onLibraryChange);
const unsubscribeAppearance = subscribeAppearance(apply);
const unsubscribeDisplay = subscribeDisplaySettings(apply);
apply();
// The cache already painted; this is only the background refresh that may add or remove themes.
// It never blocks a frame and a failure leaves the cached palette in place.
if (import.meta.env.MODE !== 'share') { void syncThemeLibrary(); void syncAppearance(); }

import.meta.hot?.dispose(() => {
  media.removeEventListener('change', onSystemChange);
  window.removeEventListener('storage', onStorageChange);
  unsubscribeLibrary();
  unsubscribeAppearance();
  unsubscribeDisplay();
});

const storedMode = (mode: ThemeMode) => shareMode || mode !== 'system' ? mode : undefined;
const storedTheme = (themeId: string) => shareMode || themeId !== DEFAULT_THEME_ID ? themeId : undefined;

export function setThemeMode(next: ThemeMode): void {
  store.set({ mode: next });
  if (!preview) writeStored(MODE_KEY, storedMode(next));
  apply();
}

export function setThemeId(next: string): void {
  releasePluginPalette();
  const themeId = themeOption(next) ? next : DEFAULT_THEME_ID;
  store.set({ themeId });
  if (!preview) writeStored(THEME_KEY, storedTheme(themeId));
  apply();
}

export function currentWorkbenchAppearance(): { themeId: string; mode: ThemeMode; activePaletteId?: string } {
  const { themeId, mode } = store.get();
  const displayed = activeThemeId(themeId);
  return { themeId, mode, ...(displayed !== themeId ? { activePaletteId: displayed } : {}) };
}

function saveWorkbenchPreferences(write: (persist: (key: string, value: string | undefined) => void) => void) {
  const storage = window.localStorage;
  const updates: Array<{ key: string; previous: string | null; written: string | null }> = [];
  const save = (key: string, value: string | null | undefined) => {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  };
  const persist = (key: string, value: string | undefined) => {
    const previous = storage.getItem(key);
    save(key, value);
    updates.push({ key, previous, written: value ?? null });
    if (storage.getItem(key) !== (value ?? null)) throw new Error('Appearance preference was not saved');
  };
  try { write(persist); }
  catch (error) {
    for (const { key, previous, written } of updates.reverse()) {
      if (storage.getItem(key) === written) save(key, previous);
    }
    throw error;
  }
  return updates;
}

function applyWorkbenchPreferences() {
  store.set({ themeId: readThemeId(), mode: readMode() });
  apply();
}

/** Writes acknowledged workbench changes and captures the exact saved values for conditional undo. */
export function workbenchThemePreferences(change: { themeId?: string; mode?: ThemeMode }): (() => boolean) | undefined {
  if (shareMode) throw new Error('Workbench appearance requires the main application');
  const before = readThemeId();
  const updates = saveWorkbenchPreferences(persist => {
    if (change.themeId !== undefined) persist(THEME_KEY, storedTheme(change.themeId));
    if (change.mode !== undefined) persist(MODE_KEY, storedMode(change.mode));
    if (change.themeId !== undefined) releasePluginPalette(persist);
  });
  applyWorkbenchPreferences();

  // A plugin palette override may depend on a preset or a package that changed since the command.
  if (updates.some(({ key }) => key !== THEME_KEY && key !== MODE_KEY)) return undefined;
  const active = currentWorkbenchAppearance().activePaletteId;
  return () => {
    const storage = window.localStorage;
    if (updates.some(({ key, written }) => storage.getItem(key) !== written)) return false;
    if (change.themeId !== undefined && (!themeOption(before) || currentWorkbenchAppearance().activePaletteId !== active)) return false;
    saveWorkbenchPreferences(persist => {
      for (const { key, previous } of updates) persist(key, previous ?? undefined);
    });
    applyWorkbenchPreferences();
    return true;
  };
}

/**
 * `themeId` is the built-in or custom theme the user chose, which a plugin palette does not replace.
 * While one is in effect, `paletteKey` names what is painted and `pluginAnsi` is its terminal colours.
 */
export function useTheme(): { mode: ThemeMode; themeId: string; resolved: ResolvedMode; revision: string; paletteKey?: string; pluginAnsi?: ThemeAnsi } {
  const { mode, themeId: currentId, resolved } = useStore(store, (state) => state);
  const libraryRevision = useSyncExternalStore(subscribeThemeLibrary, () => themeRevision(currentId));
  const plugin = useSyncExternalStore(subscribeAppearance, activePluginPalette);
  return {
    mode,
    themeId: currentId,
    resolved,
    // Terminal caches and effects key on this: editing a custom theme must repaint without the id
    // changing, and a revision is the only signal that distinguishes the two palettes.
    revision: plugin ? `plugin:${plugin.revision}` : libraryRevision,
    ...(plugin ? { paletteKey: plugin.key, pluginAnsi: plugin.ansi } : {}),
  };
}

/** Restore the author's frozen appearance without changing workbench preferences. */
export function resetShareAppearance(): void {
  if (!shareMode || preview || !originalAppearance) return;
  writeStored(MODE_KEY, undefined);
  writeStored(THEME_KEY, undefined);
  store.set({ mode: originalAppearance.mode, themeId: originalAppearance.themeId });
  apply();
}
