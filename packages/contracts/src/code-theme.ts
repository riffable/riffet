/**
 * Built-in code syntax highlighting contract (docs/design/system/foundations.md §1.1, docs/THEMES.md §16).
 *
 * Syntax themes are independent of the UI colour theme (`data-theme`) and mode (`.dark`): a reader
 * can follow the active UI theme (`auto`) or pick a dedicated syntax palette. Code blocks always sit
 * on the UI theme's own surfaces (`bg-subtle` / `bg`) and mix syntax hues slightly toward `fg` /
 * `fg-3`, so every syntax theme remains legible on any paper.
 */

export const CODE_THEME_ROLES = [
  'comment',
  'keyword',
  'string',
  'number',
  'constant',
  'declaration',
  'type',
  'property',
  'namespace',
  'tag',
  'attribute',
  'annotation',
  'escape',
  'heading',
] as const;

export type CodeThemeRole = (typeof CODE_THEME_ROLES)[number];

export type CodeThemePalette = Record<CodeThemeRole, string>;

export interface CodeThemeHalf {
  readonly colors: CodeThemePalette;
  readonly commentItalic?: boolean;
}

export interface CustomCodeSyntaxHalf {
  colors: CodeThemePalette;
  commentItalic?: boolean;
}

export interface CustomCodeSyntax {
  light: CustomCodeSyntaxHalf;
  dark: CustomCodeSyntaxHalf;
}

export interface BuiltinCodeTheme {
  readonly id: BuiltinCodeThemeId;
  readonly name: string;
  readonly credit?: string;
  readonly light: CodeThemeHalf;
  readonly dark: CodeThemeHalf;
}

export const CODE_THEME_AUTO = 'auto';
export const DEFAULT_CODE_THEME_ID = 'intellij';

export const BUILTIN_CODE_THEME_IDS = [
  'intellij',
  'github',
  'vitesse',
  'one',
  'catppuccin',
  'solarized',
  'rose-pine',
  'everforest',
  'monochrome',
] as const;

export type BuiltinCodeThemeId = (typeof BUILTIN_CODE_THEME_IDS)[number];
export type CustomCodeThemeId = `custom-${string}`;
export type CodeThemeSelection = typeof CODE_THEME_AUTO | BuiltinCodeThemeId | CustomCodeThemeId;

const CUSTOM_CODE_THEME_ID = /^custom-[a-z0-9-]{8,64}$/;

/** UI themes that carry a matching syntax palette when `codeTheme` is set to `auto`. */
export const UI_THEME_DEFAULT_CODE_THEME: Readonly<Record<string, BuiltinCodeThemeId>> = {
  solarized: 'solarized',
  catppuccin: 'catppuccin',
  'rose-pine': 'rose-pine',
  everforest: 'everforest',
  pencil: 'monochrome',
};

export function isKnownCodeThemeId(id: string | undefined | null): id is BuiltinCodeThemeId {
  return typeof id === 'string' && (BUILTIN_CODE_THEME_IDS as readonly string[]).includes(id);
}

export function isCustomCodeThemeId(id: string | undefined | null): id is CustomCodeThemeId {
  return typeof id === 'string' && CUSTOM_CODE_THEME_ID.test(id);
}

/** Validates a stored code-theme choice; unknown values fall back to `auto`. */
export function parseCodeThemeSelection(raw: string | null | undefined): CodeThemeSelection {
  if (isKnownCodeThemeId(raw) || isCustomCodeThemeId(raw)) return raw;
  return CODE_THEME_AUTO;
}

/** Resolves a stored selection plus the active UI theme id to a concrete built-in code theme id. */
export function resolveCodeThemeId(
  selection: string | undefined | null,
  uiThemeId?: string | null,
): BuiltinCodeThemeId {
  if (isKnownCodeThemeId(selection)) return selection;
  if (uiThemeId && Object.prototype.hasOwnProperty.call(UI_THEME_DEFAULT_CODE_THEME, uiThemeId)) {
    return UI_THEME_DEFAULT_CODE_THEME[uiThemeId]!;
  }
  return DEFAULT_CODE_THEME_ID;
}
