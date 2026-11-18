import { CODE_THEME_AUTO, WEB_DISPLAY_OPTIONS, parseCodeThemeSelection, type CodeThemeSelection } from '@contracts';
import { createStore, useStore } from './store';
import { readStored, writeStored } from './utils';

export type TextSize = (typeof WEB_DISPLAY_OPTIONS.textSize)[number];
export const densities = WEB_DISPLAY_OPTIONS.density;
export type Density = (typeof densities)[number];

/**
 * Reading comfort, kept on this device only — the same stance the mobile client takes, and the
 * reason these do not live in `AppSettings`: one browser's font size is not another's business.
 */
export interface DisplaySettings {
  /** Scales every text token, so menus and dialogs grow with the transcript. */
  textSize: TextSize;
  /** Scales the transcript's row gaps; it deliberately does not touch the touch-target sizes. */
  density: Density;
  /** The terminal is a fixed-pitch surface and does not follow the text scale. */
  terminalFontSize: number;
  /** Insets around both the live terminal and its history, in CSS pixels. */
  terminalPaddingHorizontal: number;
  terminalPaddingVertical: number;
  /** Code syntax highlighting theme (`auto` follows the UI theme, or a built-in id). */
  codeTheme: CodeThemeSelection;
}

const KEY = 'riffet.display';

export const textScales: Record<TextSize, number> = { small: 0.9, standard: 1, large: 1.1, 'extra-large': 1.2 };
/** The sizes the picker offers; a value read from storage is clamped but not snapped. */
export const terminalFontSizes = WEB_DISPLAY_OPTIONS.terminalFontSize;
export const MIN_TERMINAL_FONT_SIZE = WEB_DISPLAY_OPTIONS.minTerminalFontSize;
export const MAX_TERMINAL_FONT_SIZE = WEB_DISPLAY_OPTIONS.maxTerminalFontSize;
export const MAX_TERMINAL_PADDING_HORIZONTAL = WEB_DISPLAY_OPTIONS.maxHorizontalPadding;
export const MAX_TERMINAL_PADDING_VERTICAL = WEB_DISPLAY_OPTIONS.maxVerticalPadding;
export const defaultDisplaySettings: DisplaySettings = {
  textSize: 'standard', density: 'standard', terminalFontSize: 12.5,
  terminalPaddingHorizontal: 24, terminalPaddingVertical: 16,
  codeTheme: CODE_THEME_AUTO,
};

const hasOwn = <T extends object>(value: T, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Rebuilds the settings from storage. Anything unrecognised — an older build's value, a hand-edited
 * one — falls back per field rather than throwing: a preference must never be able to break opening
 * the workbench.
 */
export function parseDisplaySettings(raw: string): DisplaySettings {
  if (!raw) return { ...defaultDisplaySettings };
  let parsed: Partial<DisplaySettings>;
  try { parsed = JSON.parse(raw) as Partial<DisplaySettings>; } catch { return { ...defaultDisplaySettings }; }
  if (!parsed || typeof parsed !== 'object') return { ...defaultDisplaySettings };
  const size = parsed.terminalFontSize;
  const horizontal = parsed.terminalPaddingHorizontal;
  const vertical = parsed.terminalPaddingVertical;
  return {
    textSize: parsed.textSize && hasOwn(textScales, parsed.textSize) ? parsed.textSize : defaultDisplaySettings.textSize,
    density: parsed.density === 'compact' || parsed.density === 'relaxed' ? parsed.density : defaultDisplaySettings.density,
    terminalFontSize: typeof size === 'number' && Number.isFinite(size)
      ? Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, size))
      : defaultDisplaySettings.terminalFontSize,
    terminalPaddingHorizontal: typeof horizontal === 'number' && Number.isFinite(horizontal)
      ? Math.min(MAX_TERMINAL_PADDING_HORIZONTAL, Math.max(0, horizontal))
      : defaultDisplaySettings.terminalPaddingHorizontal,
    terminalPaddingVertical: typeof vertical === 'number' && Number.isFinite(vertical)
      ? Math.min(MAX_TERMINAL_PADDING_VERTICAL, Math.max(0, vertical))
      : defaultDisplaySettings.terminalPaddingVertical,
    codeTheme: parseCodeThemeSelection(parsed.codeTheme),
  };
}

const store = createStore<DisplaySettings>(parseDisplaySettings(readStored(KEY)));

/**
 * Applied to the root element, never to a component: `--text-scale` multiplies the `--text-*`
 * tokens and `data-density` selects the transcript's gap scale, so both reach every surface at once
 * instead of each one opting in.
 */
function apply(): void {
  const settings = store.get();
  const root = document.documentElement;
  root.dataset.density = settings.density;
  root.style.setProperty('--text-scale', String(textScales[settings.textSize]));
}

function commitDisplaySettings(patch: Partial<DisplaySettings>, persist = writeStored, current = store.get()): DisplaySettings {
  const settings = parseDisplaySettings(JSON.stringify({ ...current, ...patch }));
  persist(KEY, JSON.stringify(settings));
  store.set(settings);
  apply();
  return settings;
}

export function setDisplaySettings(patch: Partial<DisplaySettings>): void {
  commitDisplaySettings(patch);
}

/** An appearance command can acknowledge only the values this browser saved. */
export function saveWorkbenchDisplaySettings(patch: Partial<DisplaySettings>): DisplaySettings {
  const storage = window.localStorage;
  return commitDisplaySettings(patch, (key, value) => {
    if (value === undefined) throw new Error('Display settings must have a value');
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('Display settings were not saved');
  }, readWorkbenchDisplaySettings());
}

/** Reads the shared browser value even if this tab has not received its storage event yet. */
export function readWorkbenchDisplaySettings(): DisplaySettings {
  return parseDisplaySettings(window.localStorage.getItem(KEY) ?? '');
}

function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  store.set(parseDisplaySettings(readStored(KEY)));
  apply();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage);
  apply();
}
import.meta.hot?.dispose(() => {
  window.removeEventListener('storage', onStorage);
});

export function getDisplaySettings(): DisplaySettings {
  return store.get();
}

export function subscribeDisplaySettings(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function useDisplaySettings(): DisplaySettings {
  return useStore(store, (settings) => settings);
}
