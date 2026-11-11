/**
 * Custom themes, shared by the server and cached locally for the first frame.
 *
 * The split is deliberate: *which* themes exist is shared state (a theme edited on a laptop shows
 * up on the phone), while *which one this device shows* stays in `lib/theme.ts` next to the mode.
 *
 * A custom theme is applied by injecting a stylesheet with the same selectors the built-ins use —
 * `[data-theme="<id>"]:not(.dark)` and `[data-theme="<id>"].dark`. Inlining the variables on
 * `<html>` instead would break the two-half preview in `ThemeSwatch`, which reads its colours from
 * `data-theme` on an inner element, and would mix palette values with runtime variables such as
 * `--text-scale`.
 *
 * The cache is read synchronously at import time so the first frame is right; the network sync runs
 * afterwards and never blocks rendering. A failed fetch keeps the cache and the current choice.
 */

import { useSyncExternalStore } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  CUSTOM_THEME_ID_PREFIX, validateThemeLibrary,
  type CustomTheme, type ThemeLibrary, type ThemeLibraryUpdate,
} from '@contracts';
import { customThemeCss, readShareAppearance } from './theme-palette';
export { customThemeCss } from './theme-palette';
import { api } from './api';
import { isKnownTheme, themes, type ThemeDefinition } from './themes';

export const THEME_LIBRARY_KEY = 'riffet.theme.library.v1';
const STYLE_ID = 'riffet-custom-themes';

/** A picker entry: one of the stylesheet's themes or one from the shared library. */
export interface ThemeOption extends ThemeDefinition {
  /** False for the themes compiled into `styles/index.css`. */
  builtin: boolean;
  /** `builtin` for those, or the library revision a custom palette was read at. */
  revision: string;
}

const EMPTY_LIBRARY: ThemeLibrary = { version: 1, revision: '', themes: [] };
const listeners = new Set<() => void>();

const shareMode = import.meta.env.MODE === 'share';
const frozenTheme = shareMode ? readShareAppearance().customTheme : undefined;
let library: ThemeLibrary = shareMode ? { ...EMPTY_LIBRARY, revision: 'frozen', themes: frozenTheme ? [frozenTheme] : [] } : readCachedLibrary();
/** A fetch has confirmed what the server holds, so a missing id may be dereferenced. */
let synced = false;
let options: readonly ThemeOption[] = buildOptions();
let injectedCss = '';
/**
 * Bumped whenever this tab writes the library (a save) or learns of another tab's write. A fetch
 * that started earlier holds a stale answer and must not replace the newer state when it lands.
 */
let generation = 0;

function buildOptions(): readonly ThemeOption[] {
  return [
    ...themes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      get description() { return theme.description; },
      ...(theme.credit ? { credit: theme.credit } : {}),
      builtin: true,
      revision: 'builtin',
    })),
    ...library.themes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      get description() { return theme.description ?? i18n._(msg`自定义主题`); },
      builtin: false,
      revision: library.revision,
    })),
  ];
}

function readCachedLibrary(): ThemeLibrary {
  try {
    const raw = window.localStorage.getItem(THEME_LIBRARY_KEY);
    if (!raw) return EMPTY_LIBRARY;
    const checked = validateThemeLibrary(JSON.parse(raw) as unknown);
    return checked.library ?? EMPTY_LIBRARY;
  } catch {
    return EMPTY_LIBRARY;
  }
}

function writeCachedLibrary(value: ThemeLibrary): void {
  try { window.localStorage.setItem(THEME_LIBRARY_KEY, JSON.stringify(value)); }
  catch { /* a full or disabled storage must not stop the theme from applying */ }
}

/** Rewrites the injected sheet only when its content changed, so ordinary re-applies cost nothing. */
export function ensureCustomThemeCss(): void {
  const css = customThemeCss(library.themes);
  if (css === injectedCss) return;
  injectedCss = css;
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = css;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function adopt(next: ThemeLibrary): void {
  library = next;
  options = buildOptions();
  ensureCustomThemeCss();
  notify();
}

/**
 * Merges the server's library into the running app. Retries share one request; a failure leaves the
 * cache in place, because an unreachable server is not evidence that the themes were deleted.
 */
let syncing: Promise<void> | undefined;
export function syncThemeLibrary(): Promise<void> {
  if (shareMode) return Promise.resolve();
  if (syncing) return syncing;
  const started = generation;
  syncing = (async () => {
    try {
      const checked = validateThemeLibrary(await api.themes());
      // A save or another tab changed the library while this request was in flight; its answer
      // describes a state that has already been superseded.
      if (!checked.library || started !== generation) return;
      writeCachedLibrary(checked.library);
      synced = true;
      adopt(checked.library);
    } catch {
      // Keep the local cache; the next explicit sync (settings, save) tries again.
    } finally {
      syncing = undefined;
      // A successful fetch may have proven the selected custom id no longer exists.
      notify();
    }
  })();
  return syncing;
}

/** Saves the whole library with optimistic concurrency; the server's answer becomes the new state. */
export async function saveThemeLibrary(themesToSave: CustomTheme[], expectedRevision: string): Promise<ThemeLibrary> {
  // Invalidate every fetch already in flight: none of them can know about this write.
  generation += 1;
  const update: ThemeLibraryUpdate = { expectedRevision, themes: themesToSave };
  const checked = validateThemeLibrary(await api.updateThemes(update));
  if (!checked.library) throw new Error(i18n._(msg`服务器返回的主题库无法读取`));
  writeCachedLibrary(checked.library);
  synced = true;
  adopt(checked.library);
  return checked.library;
}

/** True once a fetch has confirmed what the server holds. */
export function themeLibrarySynced(): boolean {
  return synced;
}

export function themeOptions(): readonly ThemeOption[] {
  return options;
}

export function themeOption(id: string): ThemeOption | undefined {
  return options.find((option) => option.id === id);
}

export function customTheme(id: string): CustomTheme | undefined {
  return library.themes.find((theme) => theme.id === id);
}

export function isCustomThemeId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(CUSTOM_THEME_ID_PREFIX);
}

/** The ANSI slots a custom theme carries, or undefined for a built-in / unknown id. */
export function customThemeAnsi(id: string, dark: boolean): readonly string[] | undefined {
  const theme = customTheme(id);
  return theme ? (dark ? theme.ansi.dark : theme.ansi.light) : undefined;
}

/**
 * The revision native caches and terminal effects key on. Built-ins never change; custom themes
 * share the library revision, so editing one invalidates every custom palette — coarse, but cheap
 * and impossible to get subtly wrong.
 */
export function themeRevision(id: string): string {
  if (isKnownTheme(id)) return 'builtin';
  return customTheme(id) ? library.revision : 'unloaded';
}

export function currentThemeLibrary(): ThemeLibrary {
  return library;
}

export function subscribeThemeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The merged picker catalogue. The snapshot is replaced only when the library changes. */
export function useThemeOptions(): readonly ThemeOption[] {
  return useSyncExternalStore(subscribeThemeLibrary, () => options);
}

/** The running library itself, for the editor; like [useThemeOptions], stable between syncs. */
export function useCurrentThemeLibrary(): ThemeLibrary {
  return useSyncExternalStore(subscribeThemeLibrary, currentThemeLibrary);
}

ensureCustomThemeCss();

window.addEventListener('storage', (event) => {
  if (shareMode) return;
  if (event.key !== THEME_LIBRARY_KEY && event.key !== null) return;
  try { if (event.storageArea !== window.localStorage) return; } catch { return; }
  const cached = readCachedLibrary();
  if (cached.revision === library.revision) return;
  // Another tab synced with the same server; adopt its cache so both tabs paint the same palette.
  // Only a successful sync writes that key, so its contents are server-confirmed. This tab's own
  // in-flight fetch predates that write and must not undo it.
  generation += 1;
  synced = true;
  adopt(cached);
});

import.meta.hot?.dispose(() => {
  listeners.clear();
});
