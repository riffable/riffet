import {
  APPEARANCE_DEFAULT, type AppearanceBackground, type AppearanceCatalog, type AppearanceFont, type AppearanceLogo, type AppearancePalette, type AppearanceSelection,
} from '@contracts';

/**
 * What is in effect for a device's selection, kept away from the DOM and storage so the precedence
 * is one readable rule: per slot, a stored choice wins over the selected preset, and either falls
 * back to the host default (`undefined`) when it names nothing the catalog holds. A reference that
 * does not resolve shows as the default and stays stored; only the user's own pick rewrites it, so
 * turning the plugin back on restores what was chosen.
 */
export interface EffectiveAppearance {
  palette?: AppearancePalette;
  uiFont?: AppearanceFont;
  monoFont?: AppearanceFont;
  background?: AppearanceBackground;
  logo?: AppearanceLogo;
}

const KEYS = ['preset', 'palette', 'uiFont', 'monoFont', 'background', 'logo'] as const;

/** Rebuilds a selection from storage: only known keys with plain, bounded text survive. */
export function parseSelection(raw: string | null | undefined): AppearanceSelection {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const value = parsed as Record<string, unknown>;
  const selection: AppearanceSelection = {};
  for (const key of KEYS) if (typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 160) selection[key] = value[key];
  return selection;
}

function pick<T extends { id: string }>(items: readonly T[], stored: string | undefined, fromPreset: string | undefined): T | undefined {
  if (stored !== undefined) return stored === APPEARANCE_DEFAULT ? undefined : items.find((item) => item.id === stored);
  return fromPreset === undefined ? undefined : items.find((item) => item.id === fromPreset);
}

export function effectiveAppearance(selection: AppearanceSelection, catalog: AppearanceCatalog | undefined): EffectiveAppearance {
  if (!catalog) return {};
  const preset = selection.preset === undefined ? undefined : catalog.presets.find((item) => item.id === selection.preset);
  return {
    palette: pick(catalog.palettes, selection.palette, preset?.palette),
    uiFont: pick(catalog.fonts.filter((font) => font.role === 'ui'), selection.uiFont, preset?.fonts?.ui),
    monoFont: pick(catalog.fonts.filter((font) => font.role === 'mono'), selection.monoFont, preset?.fonts?.mono),
    background: pick(catalog.backgrounds.filter((item) => item.areas.includes('workbench')), selection.background, preset?.background),
    logo: pick(catalog.logos ?? [], selection.logo, preset?.logo),
  };
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'cursive', 'fantasy']);

/**
 * The font stack for a plugin font: its own face, its named fallbacks, then the host's stack (which
 * carries the CJK fonts), then its generic families. The server only lets plain family names through,
 * so quoting them is enough to keep a declaration from becoming CSS.
 */
export function fontStack(face: string, font: Pick<AppearanceFont, 'fallback'>, hostStack: string): string {
  const quote = (name: string) => `"${name}"`;
  return [
    quote(face),
    ...font.fallback.filter((name) => !GENERIC_FAMILIES.has(name)).map(quote),
    hostStack.trim(),
    ...font.fallback.filter((name) => GENERIC_FAMILIES.has(name)),
  ].filter(Boolean).join(', ');
}

/** The key a plugin palette is painted under: its content hash, so an updated palette is a new theme to every cache. */
export function paletteKey(palette: AppearancePalette): string {
  return `plugin-${palette.asset.sha256.slice(0, 16)}`;
}
