// Appearance resource packs (docs/design/plugin-system.md §6, docs/THEMES.md "插件外观"): a plugin
// declares palettes, fonts, backgrounds and presets; the server resolves their files into a catalog
// of content-addressed assets that clients fetch, cache and apply. Built-in themes, `themes.json`
// and `/api/themes` are untouched.

import type { LocalizedText } from './plugins.js';

export const APPEARANCE_FONT_ROLES = ['ui', 'mono'] as const;
export type AppearanceFontRole = typeof APPEARANCE_FONT_ROLES[number];
export const APPEARANCE_FONT_STYLES = ['normal', 'italic'] as const;
export const APPEARANCE_BACKGROUND_AREAS = ['workbench'] as const;
export type AppearanceBackgroundArea = typeof APPEARANCE_BACKGROUND_AREAS[number];
export const APPEARANCE_BACKGROUND_FITS = ['cover', 'tile', 'contain'] as const;
export type AppearanceBackgroundFit = typeof APPEARANCE_BACKGROUND_FITS[number];
export const APPEARANCE_BACKGROUND_PLACEMENTS = ['overlay', 'underlay'] as const;
export type AppearanceBackgroundPlacement = typeof APPEARANCE_BACKGROUND_PLACEMENTS[number];
export const APPEARANCE_BACKGROUND_POSITIONS = [
  'center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right',
] as const;
export type AppearanceBackgroundPosition = typeof APPEARANCE_BACKGROUND_POSITIONS[number];

/** Largest file the server will serve per kind of asset. */
export const APPEARANCE_MAX_FONT_BYTES = 2 * 1024 * 1024;
export const APPEARANCE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const APPEARANCE_MAX_LOGO_BYTES = 512 * 1024;
export const APPEARANCE_MAX_PALETTE_BYTES = 256 * 1024;

/** The value of a stored per-item choice that means "the host default", even when the selected preset names one. */
export const APPEARANCE_DEFAULT = 'default';

// ── Declarations, in a package manifest ──────────────────────────────────────────────────────────

/** `asset` is a JSON file of exactly one `CustomTheme` (theme.ts). Its own `id` and `name` are ignored: a palette is identified by this contribution id. */
export interface PaletteDeclaration { id: string; title: LocalizedText; asset: string }

/**
 * Whether a frozen share may carry the file (docs/design/plugin-system.md §6). A declaration with no `license`
 * is not redistributable: a share leaves it out and shows the host default instead.
 */
export interface AppearanceLicense { redistributable: boolean }

export interface FontFileDeclaration {
  /** A `.woff2` path inside the package. */
  path: string;
  /** A CSS weight or weight range such as `400` or `100 900`. */
  weight?: string;
  style?: typeof APPEARANCE_FONT_STYLES[number];
  /** CSS `unicode-range` of a subset file, such as `U+0000-00FF`; the web needs it to tell subsets of one family apart. */
  unicodeRange?: string;
}

export interface FontDeclaration {
  id: string;
  title: LocalizedText;
  role: AppearanceFontRole;
  /** The family name the font files carry. */
  family: string;
  files: FontFileDeclaration[];
  /** Family names or generic families, tried in order after this font. */
  fallback: string[];
  license?: AppearanceLicense;
}

export interface BackgroundDeclaration {
  id: string;
  title: LocalizedText;
  /** A `.png`, `.jpg` or `.webp` path inside the package. */
  asset: string;
  /** Optional dark-mode image; `asset` is used in both modes when omitted. */
  darkAsset?: string;
  areas: AppearanceBackgroundArea[];
  /** 0 to 1; 1 when omitted. */
  opacity?: number;
  fit?: AppearanceBackgroundFit;
  /** `overlay` draws over the workbench (paper grain); `underlay` sits behind surfaces (wallpaper). Defaults to `overlay`. */
  placement?: AppearanceBackgroundPlacement;
  /** CSS alignment within the viewport; defaults to `center`. */
  position?: AppearanceBackgroundPosition;
  /** 0 to 1 opacity of the main content card when `placement` is `underlay`. */
  surfaceOpacity?: number;
  license?: AppearanceLicense;
}

export interface LogoDeclaration {
  id: string;
  title: LocalizedText;
  /** A `.png`, `.jpg`, `.webp` or `.svg` path inside the package. */
  asset: string;
  /** Optional dark-mode logo; `asset` is used in both modes when omitted. */
  darkAsset?: string;
  license?: AppearanceLicense;
}

/** References are contribution ids, possibly of other plugins; a missing one is skipped at display time. */
export interface PresetDeclaration {
  id: string;
  title: LocalizedText;
  palette?: string;
  fonts?: { ui?: string; mono?: string };
  background?: string;
  logo?: string;
}

export interface IconPackDeclaration { id: string; title: LocalizedText; asset: string }

export interface AppearanceDeclarations {
  iconPacks?: IconPackDeclaration[];
  palettes?: PaletteDeclaration[];
  fonts?: FontDeclaration[];
  backgrounds?: BackgroundDeclaration[];
  logos?: LogoDeclaration[];
  presets?: PresetDeclaration[];
}

// ── The catalog, `GET /api/appearance` ───────────────────────────────────────────────────────────

/** A file the server vouches for. `url` is `/api/appearance/assets/<pluginId>/<sha256>`: the bytes at it never change. */
export interface AppearanceAsset { url: string; sha256: string; size: number; type: string }

export interface AppearancePalette { id: string; plugin: string; title: LocalizedText; asset: AppearanceAsset }
export interface AppearanceFont {
  id: string;
  plugin: string;
  title: LocalizedText;
  role: AppearanceFontRole;
  family: string;
  fallback: string[];
  files: Array<AppearanceAsset & { weight?: string; style?: 'normal' | 'italic'; unicodeRange?: string }>;
}
export interface AppearanceBackground {
  id: string;
  plugin: string;
  title: LocalizedText;
  asset: AppearanceAsset;
  darkAsset?: AppearanceAsset;
  areas: AppearanceBackgroundArea[];
  opacity: number;
  fit: AppearanceBackgroundFit;
  placement?: AppearanceBackgroundPlacement;
  position?: AppearanceBackgroundPosition;
  surfaceOpacity?: number;
}
export interface AppearanceLogo {
  id: string;
  plugin: string;
  title: LocalizedText;
  asset: AppearanceAsset;
  darkAsset?: AppearanceAsset;
}
export interface AppearancePreset {
  id: string;
  plugin: string;
  title: LocalizedText;
  palette?: string;
  fonts?: { ui?: string; mono?: string };
  background?: string;
  logo?: string;
}

/** What the enabled plugins contribute. `revision` is a content hash of everything else. */
export interface AppearanceCatalog {
  version: 1;
  revision: string;
  iconPacks?: AppearancePalette[];
  palettes: AppearancePalette[];
  fonts: AppearanceFont[];
  backgrounds: AppearanceBackground[];
  logos?: AppearanceLogo[];
  presets: AppearancePreset[];
}

/**
 * What a device keeps per server (web localStorage, macOS UserDefaults). Each field is a
 * contribution id, or {@link APPEARANCE_DEFAULT}. Precedence: host default, then the preset, then a
 * field set here. An id whose contribution is missing or disabled shows as the default and stays
 * stored, so turning the plugin back on restores it.
 */
export interface AppearanceSelection {
  preset?: string;
  palette?: string;
  uiFont?: string;
  monoFont?: string;
  background?: string;
  logo?: string;
}
