/** Versioned design overrides: allowlisted data, never executable code or arbitrary CSS. */
import type { ThemeValidationIssue } from './theme.js';

export const THEME_TEXT_ROLES = [
  'title', 'body', 'bodySmall', 'label', 'caption', 'mono', 'monoSmall', 'largeTitle', 'barTitle',
  'headline', 'subhead', 'footnote', 'button', 'buttonSmall', 'input', 'segmented', 'menu', 'dialogTitle', 'dialogBody',
] as const;

/** dp. Layout bounds also keep configurable touch targets at least 48dp tall. */
export const THEME_DIMENSION_BOUNDS = {
  pageInset: [0, 128], groupInset: [0, 128], sectionGap: [0, 128], rowPadding: [0, 128],
  rowHeight: [32, 160], rowSubtitleHeight: [32, 160], iconSize: [12, 64], smallIconSize: [8, 48],
  iconSlot: [16, 80], iconTileRadius: [0, 32], controlHeight: [48, 160], controlInset: [0, 128],
  groupRadius: [0, 64], menuRadius: [0, 64], controlRadius: [0, 64], rowRadius: [0, 64],
  selectionRadius: [0, 64], composerRadius: [0, 64], barHeight: [44, 160], tabBarHeight: [44, 160],
  tabBarInset: [0, 128], tabBarBottomInset: [0, 128], drawerWidth: [160, 1024], drawerMinGap: [32, 256],
  menuMinWidth: [120, 1024], menuMaxWidth: [120, 2048], menuRowHeight: [32, 160], menuGroupGap: [0, 128],
  hairlineWidth: [0, 4], focusWidth: [0, 8], alertWidth: [200, 1024], sheetMaxWidth: [240, 2048],
  dialogInset: [0, 128], inputMinHeight: [44, 512], inputInset: [0, 128], segmentedHeight: [28, 80],
  switchWidth: [32, 100], switchHeight: [20, 60], switchThumbSize: [12, 56], sliderTrackHeight: [1, 16],
  sliderThumbSize: [12, 64], sendButtonSize: [24, 80], composerMinHeight: [48, 512], composerMaxHeight: [48, 2048],
  floatingShadowRadius: [0, 64], floatingShadowLiftedRadius: [0, 96], floatingShadowOffset: [-32, 32],
  floatingShadowSpread: [-32, 32], buttonIconSize: [12, 64], contentMaxWidth: [240, 4096], pageTitleGap: [0, 128],
} as const;
export const THEME_MOTION_BOUNDS = {
  short: [0, 2000], medium: [0, 2000], long: [0, 2000], exit: [0, 2000], pageEnter: [0, 2000], pageExit: [0, 2000],
  settleDamping: [0.5, 2], settleStiffness: [50, 5000], spatialDamping: [0.5, 2], spatialStiffness: [50, 5000], effectsStiffness: [50, 5000],
  coveredPageShift: [0, 1], coveredPageDim: [0, 1], pressOpacity: [0.1, 1], disabledOpacity: [0, 1],
  floatingShadowOpacity: [0, 1], popScale: [0, 1], sharedAxisFraction: [0, 1],
} as const;
export const THEME_DESIGN_COLOR_ROLES = [
  'page', 'groupedPage', 'card', 'floating', 'press', 'selected', 'selectedContent', 'disabledContent', 'focus', 'hairline',
  'shadow', 'input', 'navigation', 'scrim', 'primaryAction', 'primaryActionContent', 'secondaryAction', 'secondaryActionContent', 'switchThumb',
] as const;
export const THEME_DESIGN_VARIANTS = {
  settingsIcons: ['plain', 'tonal'], navigation: ['flat', 'floating'], homeTabs: ['underline', 'segmented'], secondaryButtons: ['plain', 'tinted'],
} as const;

export type ThemeTextRole = (typeof THEME_TEXT_ROLES)[number];
export type ThemeDimension = keyof typeof THEME_DIMENSION_BOUNDS;
export type ThemeMotion = keyof typeof THEME_MOTION_BOUNDS;
export type ThemeDesignColorRole = (typeof THEME_DESIGN_COLOR_ROLES)[number];
export type ThemeDesignVariants = { [K in keyof typeof THEME_DESIGN_VARIANTS]?: (typeof THEME_DESIGN_VARIANTS)[K][number] };
export interface ThemeTextStyle {
  size?: number;
  lineHeight?: number;
  weight?: number;
  letterSpacing?: number;
  family?: 'system' | 'sans' | 'serif' | 'mono';
}
export interface ThemeDesignColors {
  light?: Partial<Record<ThemeDesignColorRole, string>>;
  dark?: Partial<Record<ThemeDesignColorRole, string>>;
}
export interface ThemeDesignTokens {
  typography?: Partial<Record<ThemeTextRole, ThemeTextStyle>>;
  dimensions?: Partial<Record<ThemeDimension, number>>;
  motion?: Partial<Record<ThemeMotion, number>>;
  colors?: ThemeDesignColors;
  variants?: ThemeDesignVariants;
}
export interface ThemeDesign {
  version: 1;
  tokens?: ThemeDesignTokens;
  styles?: Partial<Record<(typeof THEME_INTERFACE_STYLES)[number], ThemeDesignTokens>>;
}
export const THEME_INTERFACE_STYLES = ['material3', 'ios', 'expressive', 'miuix', 'fluent'] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(issues: ThemeValidationIssue[], path: string, value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) { issues.push({ path, message: 'must be an object' }); return false; }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) issues.push({ path: path + '.' + key, message: 'is not a design field' });
  }
  return true;
}
function number(issues: ThemeValidationIssue[], path: string, value: unknown, min: number, max: number, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    issues.push({ path, message: 'must be ' + (integer ? 'an integer' : 'a number') + ' between ' + min + ' and ' + max });
  }
}
function numericMap(issues: ThemeValidationIssue[], path: string, value: unknown, bounds: Record<string, readonly [number, number]>): void {
  if (!object(issues, path, value, Object.keys(bounds))) return;
  for (const [key, item] of Object.entries(value)) {
    const range = Object.hasOwn(bounds, key) ? bounds[key] : undefined;
    if (range) number(issues, path + '.' + key, item, range[0], range[1]);
  }
}
function orderedPair(issues: ThemeValidationIssue[], path: string, values: Record<string, unknown>, lower: string, upper: string): void {
  if (typeof values[lower] === 'number' && typeof values[upper] === 'number' && values[lower] > values[upper]) {
    issues.push({ path: path + '.' + lower, message: 'must not exceed ' + upper });
  }
}
function checkTokens(issues: ThemeValidationIssue[], path: string, value: unknown): void {
  if (!object(issues, path, value, ['typography', 'dimensions', 'motion', 'colors', 'variants'])) return;
  if (value.typography !== undefined && object(issues, path + '.typography', value.typography, THEME_TEXT_ROLES)) {
    for (const [role, style] of Object.entries(value.typography)) {
      const at = path + '.typography.' + role;
      if (!object(issues, at, style, ['size', 'lineHeight', 'weight', 'letterSpacing', 'family'])) continue;
      if (style.size !== undefined) number(issues, at + '.size', style.size, 8, 72);
      if (style.lineHeight !== undefined) number(issues, at + '.lineHeight', style.lineHeight, 8, 100);
      if (style.weight !== undefined) number(issues, at + '.weight', style.weight, 100, 900, true);
      if (style.letterSpacing !== undefined) number(issues, at + '.letterSpacing', style.letterSpacing, -4, 8);
      if (style.family !== undefined && !['system', 'sans', 'serif', 'mono'].includes(style.family as string)) {
        issues.push({ path: at + '.family', message: 'must be system, sans, serif or mono' });
      }
      orderedPair(issues, at, style, 'size', 'lineHeight');
    }
  }
  if (value.dimensions !== undefined) {
    numericMap(issues, path + '.dimensions', value.dimensions, THEME_DIMENSION_BOUNDS);
    if (record(value.dimensions)) {
      for (const [lower, upper] of [['menuMinWidth', 'menuMaxWidth'], ['composerMinHeight', 'composerMaxHeight'], ['rowHeight', 'rowSubtitleHeight'], ['switchThumbSize', 'switchHeight'], ['switchHeight', 'switchWidth']]) {
        orderedPair(issues, path + '.dimensions', value.dimensions, lower!, upper!);
      }
    }
  }
  if (value.motion !== undefined) numericMap(issues, path + '.motion', value.motion, THEME_MOTION_BOUNDS);
  if (value.colors !== undefined && object(issues, path + '.colors', value.colors, ['light', 'dark'])) {
    for (const mode of ['light', 'dark']) {
      const colors = value.colors[mode];
      if (colors === undefined || !object(issues, path + '.colors.' + mode, colors, THEME_DESIGN_COLOR_ROLES)) continue;
      for (const [role, color] of Object.entries(colors)) {
        if (typeof color !== 'string' || !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) {
          issues.push({ path: path + '.colors.' + mode + '.' + role, message: 'must be #rrggbb or #rrggbbaa' });
        }
      }
    }
  }
  if (value.variants !== undefined && object(issues, path + '.variants', value.variants, Object.keys(THEME_DESIGN_VARIANTS))) {
    for (const [key, variant] of Object.entries(value.variants)) {
      const options = Object.hasOwn(THEME_DESIGN_VARIANTS, key)
        ? THEME_DESIGN_VARIANTS[key as keyof typeof THEME_DESIGN_VARIANTS] as readonly string[] : undefined;
      if (options && (typeof variant !== 'string' || !options.includes(variant))) {
        issues.push({ path: path + '.variants.' + key, message: 'must be ' + options.join(' or ') });
      }
    }
  }
}

/** Reject unknown keys before canonicalization; malformed overrides must not be silently lost. */
export function checkThemeDesign(issues: ThemeValidationIssue[], path: string, value: unknown): void {
  if (!object(issues, path, value, ['version', 'tokens', 'styles'])) return;
  if (value.version !== 1) issues.push({ path: path + '.version', message: 'must be 1' });
  if (value.tokens !== undefined) checkTokens(issues, path + '.tokens', value.tokens);
  if (value.styles !== undefined && object(issues, path + '.styles', value.styles, THEME_INTERFACE_STYLES)) {
    for (const [style, tokens] of Object.entries(value.styles)) checkTokens(issues, path + '.styles.' + style, tokens);
  }
}

/** Canonical field order, lowercase colours, and omission of empty leaf patches. */
export function normalizeThemeDesign(design: ThemeDesign): ThemeDesign {
  const tokens = normalizeTokens(design.tokens);
  const styles: ThemeDesign['styles'] = {};
  for (const style of THEME_INTERFACE_STYLES) {
    const patch = normalizeTokens(design.styles?.[style]);
    if (patch) styles[style] = patch;
  }
  return { version: 1, ...(tokens ? { tokens } : {}), ...(Object.keys(styles).length ? { styles } : {}) };
}
function normalizeTokens(tokens: ThemeDesignTokens | undefined): ThemeDesignTokens | undefined {
  if (!tokens) return undefined;
  const result: ThemeDesignTokens = {};
  const typography: ThemeDesignTokens['typography'] = {};
  for (const role of THEME_TEXT_ROLES) {
    const style = tokens.typography?.[role];
    if (!style) continue;
    const ordered = Object.fromEntries(['size', 'lineHeight', 'weight', 'letterSpacing', 'family']
      .filter(key => style[key as keyof ThemeTextStyle] !== undefined).map(key => [key, style[key as keyof ThemeTextStyle]]));
    if (Object.keys(ordered).length) typography[role] = ordered;
  }
  if (Object.keys(typography).length) result.typography = typography;
  for (const [key, keys] of [['dimensions', Object.keys(THEME_DIMENSION_BOUNDS)], ['motion', Object.keys(THEME_MOTION_BOUNDS)]] as const) {
    const values = tokens[key] as Record<string, number> | undefined;
    const ordered = Object.fromEntries(keys.filter(name => values?.[name] !== undefined).map(name => [name, values![name]]));
    if (Object.keys(ordered).length) result[key] = ordered;
  }
  const colors: ThemeDesignColors = {};
  for (const mode of ['light', 'dark'] as const) {
    const ordered = Object.fromEntries(THEME_DESIGN_COLOR_ROLES.filter(role => tokens.colors?.[mode]?.[role] !== undefined)
      .map(role => [role, tokens.colors![mode]![role]!.toLowerCase()]));
    if (Object.keys(ordered).length) colors[mode] = ordered;
  }
  if (Object.keys(colors).length) result.colors = colors;
  const variants = Object.fromEntries(Object.keys(THEME_DESIGN_VARIANTS).filter(key => tokens.variants?.[key as keyof ThemeDesignVariants] !== undefined)
    .map(key => [key, tokens.variants![key as keyof ThemeDesignVariants]]));
  if (Object.keys(variants).length) result.variants = variants;
  return Object.keys(result).length ? result : undefined;
}
