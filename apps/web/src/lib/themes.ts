import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/**
 * The built-in theme catalogue.
 *
 * A theme is a *pair*: one light palette and one dark palette that share the same 53 role names.
 * That is the shape the stylesheet already had (`:root` + `.dark`) and the shape every upstream we
 * borrow from ships, so a theme is selected by one `data-theme` attribute while `.dark` keeps
 * carrying the mode — see `lib/theme.ts`.
 *
 * No colour lives here, on purpose. Every block in `styles/index.css` is keyed on
 * `[data-theme="<id>"]`, not on `:root`, so a swatch in the picker is just an element carrying
 * `data-theme` (plus `dark` for the dark half) and the ordinary `bg-bg` / `text-fg` / `bg-accent`
 * utilities resolve to that theme's values on their own. Duplicating the palette into TypeScript
 * would be a second source of truth that could silently drift from the stylesheet.
 */

export interface ThemeDefinition {
  id: string;
  /** Shown in the picker. Kept short: the gallery is a single column on a phone. */
  name: string;
  /** One line explaining what the palette is for, shown under the name. */
  description: string;
  /**
   * Upstream project the palette is derived from, with its licence. Empty for Riffet's own.
   * Rendered in 设置 → 外观与显示 so the attribution travels with the built-in themes.
   */
  credit?: string;
}

/**
 * The mode half of the appearance preference: which of a palette's two halves is in use.
 *
 * It lives here, next to the catalogue and the other stored-value resolvers, rather than in
 * `lib/theme.ts` — that module owns `matchMedia` and `localStorage` at import time, so anything
 * declared there cannot be unit-tested without a DOM. `lib/theme.ts` re-exports this type.
 */
export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedMode = 'light' | 'dark';

/**
 * Reads a stored mode. Anything unrecognised — an older build's value, a hand-edited one — falls
 * back to `system` rather than throwing: a preference must never be able to break opening the
 * workbench. This is the same stance `parseDisplaySettings` takes.
 */
export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** The theme every device starts on, and the fallback for any unknown stored value. */
export const DEFAULT_THEME_ID = 'riffet';

/**
 * Order is the picker's order: Riffet first, then the borrowed palettes roughly by how far each
 * one moves away from it — Solarized stays near a neutral tool surface, Catppuccin and Rosé Pine go
 * soft and warm, Everforest is the only green. Kiln and the reading palettes after it close the
 * list: Riffet's own, sharing one recipe — near-achromatic ink on a low-chroma paper, a deep status
 * trio and a single earthy accent — and differing only in the paper's temperature and that accent.
 *
 * There is deliberately no "GitHub" entry. Riffet's own palette was built by eye from Primer's
 * (its light sidebar differs from Primer's by one unit per channel), so a GitHub theme would have
 * been a second name for the default: same white page, same elevated surfaces, and — because the
 * terminal inherited Primer's ANSI — the same sixteen terminal colours. Diverging it from its own
 * published palette to make it look distinct would have made it not-GitHub.
 */
export const themes: readonly ThemeDefinition[] = [
  {
    id: 'riffet',
    name: 'Riffet',
    get description() { return i18n._(msg`默认外观：冷中性灰阶配蓝色强调。`); },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    get description() { return i18n._(msg`奶油纸底与墨绿黑，为长时间阅读设计。`); },
    credit: 'Ethan Schoonover · MIT',
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    get description() { return i18n._(msg`柔和的低对比紫调，适合暗光环境。`); },
    credit: 'Catppuccin · MIT',
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    get description() { return i18n._(msg`暖紫玫瑰调，低饱和的纸感配色。`); },
    credit: 'Rosé Pine · MIT',
  },
  {
    id: 'everforest',
    name: 'Everforest',
    get description() { return i18n._(msg`低饱和绿色系，暖而沉稳。`); },
    credit: 'sainnhe · MIT',
  },
  {
    id: 'kiln',
    name: 'Kiln',
    get description() { return i18n._(msg`暖象牙底与黏土橙。`); },
  },
  {
    id: 'ink',
    name: 'Ink',
    get description() { return i18n._(msg`中性纸底与墨水蓝。`); },
  },
  {
    id: 'sepia',
    name: 'Sepia',
    get description() { return i18n._(msg`旧书纸底与牛血红。`); },
  },
  {
    id: 'moss',
    name: 'Moss',
    get description() { return i18n._(msg`微绿灰纸底与橄榄苔绿。`); },
  },
  {
    id: 'slate',
    name: 'Slate',
    get description() { return i18n._(msg`微冷纸底与石板蓝。`); },
  },
  {
    id: 'pencil',
    name: 'Pencil',
    get description() { return i18n._(msg`纯中性灰阶，不用彩色强调。`); },
  },
  {
    id: 'celadon',
    name: 'Celadon',
    get description() { return i18n._(msg`青瓷纸底与深青。`); },
  },
];

/**
 * Ids from before a theme was renamed. The palette is unchanged, so a stored id keeps the reader's
 * choice instead of silently falling back to the default.
 */
const THEME_ALIASES: Readonly<Record<string, string>> = { claude: 'kiln' };

/** The current id for a stored one, or the input when it was never renamed. */
export function canonicalThemeId(id: string | undefined | null): string | undefined {
  return typeof id === 'string' ? THEME_ALIASES[id] ?? id : undefined;
}

export function isKnownTheme(id: string | undefined | null): id is string {
  return typeof id === 'string' && themes.some((theme) => theme.id === id);
}

/** Falls back rather than throwing: a hand-edited or stale id must never break opening the app. */
export function resolveThemeId(id: string | undefined | null): string {
  const canonical = canonicalThemeId(id);
  return isKnownTheme(canonical) ? canonical : DEFAULT_THEME_ID;
}

export function themeDefinition(id: string): ThemeDefinition {
  return themes.find((theme) => theme.id === id) ?? themes[0]!;
}
