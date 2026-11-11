import { checkThemeDesign, normalizeThemeDesign, type ThemeDesign } from './theme-design.js';
export * from './theme-design.js';

/**
 * The user-theme contract, shared by the web client, the server and the generator.
 *
 * A custom theme is self-contained: one palette for each mode plus its own sixteen ANSI slots.
 * ANSI is required on purpose. The sixteen slots are a contract with the programs running inside a
 * terminal, not a second view of the app's 53 roles, so deriving them per client would drift.
 *
 * Role keys are the CSS custom-property names *without* the leading `--` (`bg`, `bg-sidebar`,
 * `chart-1`). The web rebuilds the `--` prefix when it writes a theme block, which means a stored
 * key can never become an arbitrary CSS property.
 */

/** Every colour role a palette must define, in stylesheet order. Mirrored by `styles/index.css`. */
export const THEME_ROLES = [
  'bg', 'bg-sidebar', 'bg-subtle', 'bg-muted', 'bg-elevated', 'bg-popover', 'bg-hover', 'bg-active', 'bg-bubble',
  'fg', 'fg-2', 'fg-3', 'fg-4',
  'line', 'line-soft', 'line-strong',
  'primary', 'primary-hover', 'primary-fg',
  'accent', 'accent-hover', 'accent-soft', 'accent-fg',
  'success', 'success-soft',
  'warning', 'warning-soft',
  'danger', 'danger-soft', 'danger-fg',
  'diff-add', 'diff-add-gutter', 'diff-add-marker', 'diff-add-strong',
  'diff-del', 'diff-del-gutter', 'diff-del-marker', 'diff-del-strong',
  'toast', 'toast-success', 'toast-danger',
  'agent-cursor', 'agent-codex', 'agent-claude', 'agent-dsh',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8',
] as const;

export type ThemeRole = (typeof THEME_ROLES)[number];

/** The 16 ANSI slots in SGR 30–37 / 90–97 order. Custom themes store an array in this order. */
export const THEME_ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export const MAX_CUSTOM_THEMES = 50;
export const MAX_THEME_LIBRARY_BYTES = 256 * 1024;
export const CUSTOM_THEME_ID_PREFIX = 'custom-';

export type ThemePalette = Record<ThemeRole, string>;

export interface ThemeAnsi {
  /** Exactly 16 `#rrggbb` values, in [THEME_ANSI_KEYS] order. */
  light: string[];
  dark: string[];
}

export interface CustomTheme {
  /** `custom-<uuid>`; never a built-in id. */
  id: string;
  name: string;
  description?: string;
  palette: { light: ThemePalette; dark: ThemePalette };
  ansi: ThemeAnsi;
  /** Absence retains style defaults and the legacy content hash. */
  design?: ThemeDesign;
  /**
   * The canvas the palette was drawn from, kept so the editor can reopen it. The palette stays the
   * source of truth: clients paint [palette] and never derive from this.
   */
  seed?: ThemeSeed;
}

/** One point on the canvas: [hue] is the OKLCH hue in degrees, [radius] runs from grey (0) to full colour (1). */
export interface ThemeSeedPoint {
  hue: number;
  radius: number;
}

export interface ThemeSeed {
  /** The surface point, then the optional accent and sidebar points. */
  points: ThemeSeedPoint[];
  /** 0 keeps day white and night black; 1 softens both. */
  softness: number;
}

export const MAX_THEME_SEED_POINTS = 3;

/** `GET /api/themes` and the local cache. `revision` is an opaque content hash. */
export interface ThemeLibrary {
  version: 1;
  revision: string;
  themes: CustomTheme[];
}

/** `PUT /api/themes`: replace the whole library if the caller still holds [expectedRevision]. */
export interface ThemeLibraryUpdate {
  expectedRevision: string;
  themes: CustomTheme[];
}

export interface ThemeValidationIssue {
  /** Dotted path such as `themes[0].palette.light.bg`. */
  path: string;
  message: string;
}

const THEME_ID = /^custom-[a-z0-9-]{8,64}$/;
/** Custom palettes are stored as hex only; the editor normalizes before saving. */
const HEX_THEME_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const HEX_ANSI_COLOR = /^#[0-9a-f]{6}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The CSS colour forms the stylesheet uses. Kept here so the generator and the editor agree. */
export type Rgba = readonly [number, number, number, number];

export function parseColor(value: string): Rgba | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1]!.length <= 4
      ? hex[1]!.split('').map((character) => character + character).join('')
      : hex[1]!;
    const channel = (at: number) => parseInt(digits.slice(at, at + 2), 16);
    return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) / 255 : 1];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/i.exec(value.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4])];
  return null;
}

/** Lowercase `#rrggbb`, or `#rrggbbaa` when the colour is translucent. */
export function colorToHex(color: Rgba): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  const rgb = `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
  return color[3] >= 1 ? rgb : `${rgb}${channel(color[3] * 255)}`;
}

/** A stored custom-theme colour: hex only, normalized to lowercase. */
export function normalizeThemeColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_THEME_COLOR.test(value) ? value.toLowerCase() : null;
}

/** Flattens a translucent colour onto an opaque one, which is what a browser paints. */
export function composite(color: Rgba, background: Rgba): [number, number, number] {
  return [0, 1, 2].map((at) => color[at]! * color[3] + background[at]! * (1 - color[3])) as [number, number, number];
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.slice(0, 3).map((channel) => {
    const scaled = channel! / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, compositing translucent colours as they are actually painted. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const back = composite(background, [255, 255, 255, 1]);
  const front = composite(foreground, background);
  const a = relativeLuminance(front);
  const b = relativeLuminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** OKLab coordinates of an sRGB colour; alpha is ignored. */
export function toOklab(color: Rgba): [number, number, number] {
  const [r, g, bl] = color.slice(0, 3).map((channel) => {
    const scaled = channel! / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Perceptual distance (OKLab ΔE): are two colours telling each other apart? */
export function perceptualDistance(a: Rgba, b: Rgba): number {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** True when [value] is a plain record, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkText(issues: ThemeValidationIssue[], path: string, value: unknown, max: number, required: boolean): void {
  if (value === undefined) {
    if (required) issues.push({ path, message: 'is required' });
    return;
  }
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string' });
    return;
  }
  if (CONTROL_CHARACTERS.test(value)) issues.push({ path, message: 'must not contain control characters' });
  const trimmed = value.trim();
  if (required && !trimmed) issues.push({ path, message: 'must not be empty' });
  if (trimmed.length > max) issues.push({ path, message: `must be at most ${max} characters` });
}

function checkPalette(issues: ThemeValidationIssue[], path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(THEME_ROLES as readonly string[]).includes(key)) issues.push({ path: `${path}.${key}`, message: 'is not a theme role' });
  }
  for (const role of THEME_ROLES) {
    const color = value[role];
    if (color === undefined) {
      issues.push({ path: `${path}.${role}`, message: 'is missing' });
      continue;
    }
    if (normalizeThemeColor(color) === null) issues.push({ path: `${path}.${role}`, message: 'must be #rrggbb or #rrggbbaa' });
  }
}

function checkAnsi(issues: ThemeValidationIssue[], path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return;
  }
  if (value.length !== THEME_ANSI_KEYS.length) {
    issues.push({ path, message: `must have exactly ${THEME_ANSI_KEYS.length} colours` });
    return;
  }
  value.forEach((color, index) => {
    if (typeof color !== 'string' || !HEX_ANSI_COLOR.test(color)) {
      issues.push({ path: `${path}[${index}]`, message: 'must be #rrggbb' });
    }
  });
}

function checkUnit(issues: ThemeValidationIssue[], path: string, value: unknown, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    issues.push({ path, message: `must be a number from 0 to ${max}` });
  }
}

function checkSeed(issues: ThemeValidationIssue[], path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'points' && key !== 'softness') issues.push({ path: `${path}.${key}`, message: 'is not a seed field' });
  }
  checkUnit(issues, `${path}.softness`, value.softness, 1);
  const points = value.points;
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_THEME_SEED_POINTS) {
    issues.push({ path: `${path}.points`, message: `must have 1 to ${MAX_THEME_SEED_POINTS} points` });
    return;
  }
  points.forEach((point, index) => {
    const at = `${path}.points[${index}]`;
    if (!isRecord(point) || Object.keys(point).some((key) => key !== 'hue' && key !== 'radius')) {
      issues.push({ path: at, message: 'must be an object' });
      return;
    }
    checkUnit(issues, `${at}.hue`, point.hue, 360);
    checkUnit(issues, `${at}.radius`, point.radius, 1);
  });
}

function checkTheme(issues: ThemeValidationIssue[], path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!['id', 'name', 'description', 'palette', 'ansi', 'design', 'seed'].includes(key)) issues.push({ path: `${path}.${key}`, message: 'is not a theme field' });
  }
  if (typeof value.id !== 'string' || !THEME_ID.test(value.id)) {
    issues.push({ path: `${path}.id`, message: 'must be custom- followed by 8–64 lowercase letters, digits or dashes' });
  }
  checkText(issues, `${path}.name`, value.name, 60, true);
  checkText(issues, `${path}.description`, value.description, 200, false);

  if (value.design !== undefined) checkThemeDesign(issues, path + '.design', value.design);
  if (value.seed !== undefined) checkSeed(issues, `${path}.seed`, value.seed);

  if (!isRecord(value.palette)) {
    issues.push({ path: `${path}.palette`, message: 'must be an object' });
  } else {
    if (Object.keys(value.palette).some((key) => key !== 'light' && key !== 'dark')) {
      issues.push({ path: `${path}.palette`, message: 'may only contain light and dark' });
    }
    checkPalette(issues, `${path}.palette.light`, value.palette.light);
    checkPalette(issues, `${path}.palette.dark`, value.palette.dark);
  }

  if (!isRecord(value.ansi)) {
    issues.push({ path: `${path}.ansi`, message: 'must be an object' });
  } else {
    if (Object.keys(value.ansi).some((key) => key !== 'light' && key !== 'dark')) {
      issues.push({ path: `${path}.ansi`, message: 'may only contain light and dark' });
    }
    checkAnsi(issues, `${path}.ansi.light`, value.ansi.light);
    checkAnsi(issues, `${path}.ansi.dark`, value.ansi.dark);
  }
}

/**
 * Validates a list of custom themes. Structural problems are hard errors; contrast is not checked
 * here at all, because a readable palette is the editor's advice, not the server's gate.
 */
export function validateCustomThemes(value: unknown): { themes: CustomTheme[]; issues: ThemeValidationIssue[] } {
  const issues: ThemeValidationIssue[] = [];
  if (!Array.isArray(value)) {
    issues.push({ path: 'themes', message: 'must be an array' });
    return { themes: [], issues };
  }
  if (value.length > MAX_CUSTOM_THEMES) issues.push({ path: 'themes', message: `must contain at most ${MAX_CUSTOM_THEMES} themes` });
  const ids = new Set<string>();
  value.forEach((theme, index) => {
    const before = issues.length;
    checkTheme(issues, `themes[${index}]`, theme);
    const id = isRecord(theme) && typeof theme.id === 'string' ? theme.id : undefined;
    if (id) {
      if (ids.has(id)) issues.push({ path: `themes[${index}].id`, message: 'is duplicated' });
      ids.add(id);
    }
    if (issues.length === before && byteLength(JSON.stringify(theme)) > MAX_THEME_LIBRARY_BYTES) {
      issues.push({ path: `themes[${index}]`, message: `is larger than ${MAX_THEME_LIBRARY_BYTES} bytes` });
    }
  });
  if (byteLength(JSON.stringify(value)) > MAX_THEME_LIBRARY_BYTES) {
    issues.push({ path: 'themes', message: `the library is larger than ${MAX_THEME_LIBRARY_BYTES} bytes` });
  }
  return { themes: issues.length ? [] : normalizeThemes(value as CustomTheme[]), issues };
}

/** Validates a cached / returned library, including its envelope. */
export function validateThemeLibrary(value: unknown): { library: ThemeLibrary | null; issues: ThemeValidationIssue[] } {
  if (!isRecord(value)) return { library: null, issues: [{ path: '', message: 'must be an object' }] };
  const issues: ThemeValidationIssue[] = [];
  if (value.version !== 1) issues.push({ path: 'version', message: 'must be 1' });
  if (typeof value.revision !== 'string' || !value.revision) issues.push({ path: 'revision', message: 'must be a non-empty string' });
  const checked = validateCustomThemes(value.themes);
  issues.push(...checked.issues);
  return issues.length
    ? { library: null, issues }
    : { library: { version: 1, revision: value.revision as string, themes: checked.themes }, issues };
}

/** Trims display text and orders every map by [THEME_ROLES] so the same library hashes the same. */
export function normalizeThemes(themes: CustomTheme[]): CustomTheme[] {
  return themes.map((theme) => ({
    id: theme.id,
    name: theme.name.trim(),
    ...(theme.description?.trim() ? { description: theme.description.trim() } : {}),
    palette: {
      light: orderedPalette(theme.palette.light),
      dark: orderedPalette(theme.palette.dark),
    },
    ansi: { light: [...theme.ansi.light.map((color) => color.toLowerCase())], dark: [...theme.ansi.dark.map((color) => color.toLowerCase())] },
    ...(theme.design !== undefined ? { design: normalizeThemeDesign(theme.design) } : {}),
    ...(theme.seed !== undefined ? { seed: normalizeThemeSeed(theme.seed) } : {}),
  }));
}

/** Rounds the canvas so a drag that lands on the same colour hashes the same. */
export function normalizeThemeSeed(seed: ThemeSeed): ThemeSeed {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    points: seed.points.map((point) => ({ hue: round(point.hue % 360), radius: round(point.radius) })),
    softness: round(seed.softness),
  };
}

function orderedPalette(palette: ThemePalette): ThemePalette {
  const ordered = {} as ThemePalette;
  for (const role of THEME_ROLES) ordered[role] = normalizeThemeColor(palette[role]) ?? palette[role];
  return ordered;
}

/** The bytes the server hashes for a revision. Stable across key order and display whitespace. */
export function canonicalThemesJson(themes: CustomTheme[]): string {
  return JSON.stringify(normalizeThemes(themes));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
