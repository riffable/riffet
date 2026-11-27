import { CODE_THEME_AUTO, WEB_DISPLAY_OPTIONS, parseCodeThemeSelection, type CodeThemeSelection } from '@contracts';
import { createStore, useStore } from './store';
import { readStored, writeStored } from './utils';

export type TextSize = (typeof WEB_DISPLAY_OPTIONS.textSize)[number];
export const densities = WEB_DISPLAY_OPTIONS.density;
export type Density = (typeof densities)[number];
export type TerminalCursorStyle = 'block' | 'underline' | 'bar';
export type TerminalBellMode = 'none' | 'visual' | 'sound';
export type TerminalFontWeight = '300' | '400' | '500' | '600' | '700' | '800';
export type TerminalRightClickBehavior = 'menu' | 'copyPaste';
export type TerminalRendererMode = 'auto' | 'dom';
export type SettingsPresentation = 'modal' | 'page';
export const ALL_TERMINAL_MOBILE_KEYS = [
  'esc', 'tab', 'shiftTab', 'ctrlC', 'ctrlD', 'ctrlL', 'ctrlR',
  'space', 'up', 'down', 'left', 'right',
  'slash', 'pipe', 'tilde', 'dash', 'enter',
] as const;
export type TerminalMobileKeyId = (typeof ALL_TERMINAL_MOBILE_KEYS)[number];
export const DEFAULT_TERMINAL_MOBILE_KEYS: readonly TerminalMobileKeyId[] = [
  'esc', 'tab', 'space', 'up', 'down', 'left', 'right', 'enter',
];
export const TERMINAL_FONT_WEIGHTS: readonly TerminalFontWeight[] = ['300', '400', '500', '600', '700', '800'];
export const TERMINAL_FONT_PRESETS: readonly string[] = [
  'JetBrains Mono',
  'SF Mono',
  'Menlo',
  'Monaco',
  'Fira Code',
  'Consolas',
  'Courier New',
];

/**
 * Reading comfort, kept on this device only — the same stance the mobile client takes, and the
 * reason these do not live in `AppSettings`: one browser's font size is not another's business.
 */
export interface DisplaySettings {
  /** Scales every text token, so menus and dialogs grow with the transcript. */
  textSize: TextSize;
  /** Scales the transcript's row gaps; it deliberately does not touch the touch-target sizes. */
  density: Density;
  /** Optional custom monospace font family prepended to the terminal fallback stack (empty = default). */
  terminalFontFamily: string;
  /** The terminal is a fixed-pitch surface and does not follow the text scale. */
  terminalFontSize: number;
  /** Insets around both the live terminal and its history, in CSS pixels. */
  terminalPaddingHorizontal: number;
  terminalPaddingVertical: number;
  /** Terminal cursor shape (local C-class preference). */
  terminalCursorStyle: TerminalCursorStyle;
  /** Whether the terminal cursor blinks. */
  terminalCursorBlink: boolean;
  /** Multiplier applied to terminal row height (1.0–1.8). */
  terminalLineHeight: number;
  /** Extra horizontal spacing between terminal cells in pixels (-2–6). */
  terminalLetterSpacing: number;
  /** Font weight for regular terminal text. */
  terminalFontWeight: TerminalFontWeight;
  /** Font weight for bold terminal text. */
  terminalFontWeightBold: TerminalFontWeight;
  /** Copy non-empty terminal selection to the clipboard automatically. */
  terminalCopyOnSelect: boolean;
  /** Right-click behavior inside the terminal when the app isn't tracking the mouse. */
  terminalRightClick: TerminalRightClickBehavior;
  /** Scroll to bottom automatically when typing or pasting input. */
  terminalScrollOnInput: boolean;
  /** Scroll to bottom automatically when new terminal output arrives. */
  terminalScrollOnOutput: boolean;
  /** Wheel scroll speed multiplier inside the terminal (0.5–3.0). */
  terminalScrollSensitivity: number;
  /** Web terminal renderer preference (`auto` enables WebGL2 with DOM fallback; `dom` forces DOM). */
  terminalRenderer: TerminalRendererMode;
  /** Treat macOS Option as Meta (ESC prefix) inside the terminal. */
  terminalMacOptionIsMeta: boolean;
  /** How BEL (0x07) from the terminal is surfaced locally. */
  terminalBell: TerminalBellMode;
  /** Ordered list of quick keys shown on the mobile Web terminal bar. */
  terminalMobileKeys: TerminalMobileKeyId[];
  /** Code syntax highlighting theme (`auto` follows the UI theme, or a built-in id). */
  codeTheme: CodeThemeSelection;
  /** Desktop Web settings presentation: modal workspace dialog (default) or full-page swapped sidebar. */
  settingsPresentation: SettingsPresentation;
}

const KEY = 'riffet.display';

export const textScales: Record<TextSize, number> = { small: 0.9, standard: 1, large: 1.1, 'extra-large': 1.2 };
/** The sizes the picker offers; a value read from storage is clamped but not snapped. */
export const terminalFontSizes = WEB_DISPLAY_OPTIONS.terminalFontSize;
export const MIN_TERMINAL_FONT_SIZE = WEB_DISPLAY_OPTIONS.minTerminalFontSize;
export const MAX_TERMINAL_FONT_SIZE = WEB_DISPLAY_OPTIONS.maxTerminalFontSize;
export const MAX_TERMINAL_PADDING_HORIZONTAL = WEB_DISPLAY_OPTIONS.maxHorizontalPadding;
export const MAX_TERMINAL_PADDING_VERTICAL = WEB_DISPLAY_OPTIONS.maxVerticalPadding;
export const MIN_TERMINAL_LINE_HEIGHT = 1.0;
export const MAX_TERMINAL_LINE_HEIGHT = 1.8;
export const MIN_TERMINAL_LETTER_SPACING = -2;
export const MAX_TERMINAL_LETTER_SPACING = 6;
export const MIN_TERMINAL_SCROLL_SENSITIVITY = 0.5;
export const MAX_TERMINAL_SCROLL_SENSITIVITY = 3.0;
export const defaultDisplaySettings: DisplaySettings = {
  textSize: 'standard', density: 'standard', terminalFontFamily: '', terminalFontSize: 12.5,
  terminalPaddingHorizontal: 24, terminalPaddingVertical: 16,
  terminalCursorStyle: 'block', terminalCursorBlink: true, terminalLineHeight: 1.3,
  terminalLetterSpacing: 0, terminalFontWeight: '400', terminalFontWeightBold: '700',
  terminalCopyOnSelect: false, terminalRightClick: 'menu',
  terminalScrollOnInput: true, terminalScrollOnOutput: false, terminalScrollSensitivity: 1.0,
  terminalRenderer: 'auto',
  terminalMacOptionIsMeta: false, terminalBell: 'none',
  terminalMobileKeys: [...DEFAULT_TERMINAL_MOBILE_KEYS],
  codeTheme: CODE_THEME_AUTO,
  settingsPresentation: 'modal',
};

const VALID_MOBILE_KEYS = new Set<string>(ALL_TERMINAL_MOBILE_KEYS);
const VALID_FONT_WEIGHTS = new Set<string>(TERMINAL_FONT_WEIGHTS);

function parseFontWeight(value: unknown, fallback: TerminalFontWeight): TerminalFontWeight {
  return typeof value === 'string' && VALID_FONT_WEIGHTS.has(value) ? (value as TerminalFontWeight) : fallback;
}

function parseMobileKeys(value: unknown): TerminalMobileKeyId[] {
  if (!Array.isArray(value)) return [...DEFAULT_TERMINAL_MOBILE_KEYS];
  const seen = new Set<string>();
  const out: TerminalMobileKeyId[] = [];
  for (const item of value) {
    if (typeof item === 'string' && VALID_MOBILE_KEYS.has(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item as TerminalMobileKeyId);
    }
  }
  return out.length ? out : [...DEFAULT_TERMINAL_MOBILE_KEYS];
}

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
  const lineHeight = parsed.terminalLineHeight;
  const letterSpacing = parsed.terminalLetterSpacing;
  const scrollSensitivity = parsed.terminalScrollSensitivity;
  return {
    textSize: parsed.textSize && hasOwn(textScales, parsed.textSize) ? parsed.textSize : defaultDisplaySettings.textSize,
    density: parsed.density === 'compact' || parsed.density === 'relaxed' ? parsed.density : defaultDisplaySettings.density,
    terminalFontFamily: typeof parsed.terminalFontFamily === 'string' ? parsed.terminalFontFamily.trim().slice(0, 120) : defaultDisplaySettings.terminalFontFamily,
    terminalFontSize: typeof size === 'number' && Number.isFinite(size)
      ? Math.round(Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, size)) * 2) / 2
      : defaultDisplaySettings.terminalFontSize,
    terminalPaddingHorizontal: typeof horizontal === 'number' && Number.isFinite(horizontal)
      ? Math.min(MAX_TERMINAL_PADDING_HORIZONTAL, Math.max(0, horizontal))
      : defaultDisplaySettings.terminalPaddingHorizontal,
    terminalPaddingVertical: typeof vertical === 'number' && Number.isFinite(vertical)
      ? Math.min(MAX_TERMINAL_PADDING_VERTICAL, Math.max(0, vertical))
      : defaultDisplaySettings.terminalPaddingVertical,
    terminalCursorStyle: parsed.terminalCursorStyle === 'underline' || parsed.terminalCursorStyle === 'bar'
      ? parsed.terminalCursorStyle : defaultDisplaySettings.terminalCursorStyle,
    terminalCursorBlink: typeof parsed.terminalCursorBlink === 'boolean'
      ? parsed.terminalCursorBlink : defaultDisplaySettings.terminalCursorBlink,
    terminalLineHeight: typeof lineHeight === 'number' && Number.isFinite(lineHeight)
      ? Math.round(Math.min(MAX_TERMINAL_LINE_HEIGHT, Math.max(MIN_TERMINAL_LINE_HEIGHT, lineHeight)) * 10) / 10
      : defaultDisplaySettings.terminalLineHeight,
    terminalLetterSpacing: typeof letterSpacing === 'number' && Number.isFinite(letterSpacing)
      ? Math.round(Math.min(MAX_TERMINAL_LETTER_SPACING, Math.max(MIN_TERMINAL_LETTER_SPACING, letterSpacing)) * 2) / 2
      : defaultDisplaySettings.terminalLetterSpacing,
    terminalFontWeight: parseFontWeight(parsed.terminalFontWeight, defaultDisplaySettings.terminalFontWeight),
    terminalFontWeightBold: parseFontWeight(parsed.terminalFontWeightBold, defaultDisplaySettings.terminalFontWeightBold),
    terminalCopyOnSelect: typeof parsed.terminalCopyOnSelect === 'boolean'
      ? parsed.terminalCopyOnSelect : defaultDisplaySettings.terminalCopyOnSelect,
    terminalRightClick: parsed.terminalRightClick === 'copyPaste'
      ? 'copyPaste' : defaultDisplaySettings.terminalRightClick,
    terminalScrollOnInput: typeof parsed.terminalScrollOnInput === 'boolean'
      ? parsed.terminalScrollOnInput : defaultDisplaySettings.terminalScrollOnInput,
    terminalScrollOnOutput: typeof parsed.terminalScrollOnOutput === 'boolean'
      ? parsed.terminalScrollOnOutput : defaultDisplaySettings.terminalScrollOnOutput,
    terminalScrollSensitivity: typeof scrollSensitivity === 'number' && Number.isFinite(scrollSensitivity)
      ? Math.round(Math.min(MAX_TERMINAL_SCROLL_SENSITIVITY, Math.max(MIN_TERMINAL_SCROLL_SENSITIVITY, scrollSensitivity)) * 10) / 10
      : defaultDisplaySettings.terminalScrollSensitivity,
    terminalRenderer: parsed.terminalRenderer === 'dom' ? 'dom' : defaultDisplaySettings.terminalRenderer,
    terminalMacOptionIsMeta: typeof parsed.terminalMacOptionIsMeta === 'boolean'
      ? parsed.terminalMacOptionIsMeta : defaultDisplaySettings.terminalMacOptionIsMeta,
    terminalBell: parsed.terminalBell === 'visual' || parsed.terminalBell === 'sound'
      ? parsed.terminalBell : defaultDisplaySettings.terminalBell,
    terminalMobileKeys: parseMobileKeys(parsed.terminalMobileKeys),
    codeTheme: parseCodeThemeSelection(parsed.codeTheme),
    settingsPresentation: parsed.settingsPresentation === 'page' ? 'page' : defaultDisplaySettings.settingsPresentation,
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
