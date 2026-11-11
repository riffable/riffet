import {
  colorToHex, contrastRatio, normalizeThemeColor, normalizeThemeSeed, parseColor, toOklab,
  type Rgba, type ThemePalette, type ThemeRole, type ThemeSeed, type ThemeSeedPoint,
} from '@contracts';

/**
 * The theme canvas: a couple of points become the roles a reader feels as "the theme" — surfaces,
 * ink, lines, the primary action and the accent. Status, diff, agent and the rest of the chart
 * roles keep the values the draft started from; they carry meaning that one hue cannot.
 *
 * Everything is computed in OKLCH so a hue keeps its perceived lightness, then fitted into sRGB by
 * giving up chroma, never lightness. Text is walked away from its background until it meets the
 * contrast the editor's advice asks for.
 */

type Mode = 'light' | 'dark';
type Palettes = { light: ThemePalette; dark: ThemePalette };

/** How much colour the surface point can put into paper at the canvas edge. */
const SURFACE_CHROMA = 0.035;
/** The sidebar may carry more colour than the page: it frames the work rather than holding it. */
const SIDEBAR_CHROMA = 0.06;

/**
 * The offsets from the surface hue the harmony control steps through, per number of points:
 * complementary / split-complementary, triadic, analogous.
 */
const HARMONIES: Record<number, number[][]> = {
  2: [[180], [120], [40]],
  3: [[150, 210], [120, 240], [40, 320]],
};

export const SEED_ROLES = [
  'bg', 'bg-sidebar', 'bg-subtle', 'bg-muted', 'bg-elevated', 'bg-popover', 'bg-hover', 'bg-active', 'bg-bubble',
  'fg', 'fg-2', 'fg-3', 'fg-4',
  'line', 'line-soft', 'line-strong',
  'primary', 'primary-hover', 'primary-fg',
  'accent', 'accent-hover', 'accent-soft', 'accent-fg',
  'toast', 'chart-1',
] as const satisfies readonly ThemeRole[];

type SeedRole = (typeof SEED_ROLES)[number];

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
  ];
  return linear.map((value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255) as [number, number, number];
}

const inGamut = (rgb: readonly number[]) => rgb.every((channel) => channel >= -0.5 && channel <= 255.5);

/** The OKLCH colour as sRGB, losing chroma (not lightness) until it fits. */
function fit(l: number, c: number, h: number, alpha = 1): Rgba {
  const lightness = Math.min(1, Math.max(0, l));
  let rgb = oklchToRgb(lightness, c, h);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = c;
    for (let step = 0; step < 14; step += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToRgb(lightness, mid, h))) low = mid; else high = mid;
    }
    rgb = oklchToRgb(lightness, low, h);
  }
  const clamp = (value: number) => Math.min(255, Math.max(0, value));
  return [clamp(rgb[0]), clamp(rgb[1]), clamp(rgb[2]), alpha];
}

const hex = (l: number, c: number, h: number, alpha = 1) => colorToHex(fit(l, c, h, alpha));

/** Steps lightness away from [background] until the ink reaches [minimum]:1. */
function readable(l: number, c: number, h: number, background: Rgba, minimum: number, darker: boolean): string {
  let lightness = l;
  for (let step = 0; step < 60 && contrastRatio(fit(lightness, c, h), background) < minimum; step += 1) {
    lightness += darker ? -0.01 : 0.01;
  }
  return hex(lightness, c, h);
}

/** Whichever of two inks reads better on [fill]. */
function onFill(fill: Rgba, a: string, b: string): string {
  const ratio = (ink: string) => contrastRatio(parseColor(ink)!, fill);
  return ratio(a) >= ratio(b) ? a : b;
}

/** Yellow and green look muddy at the lightness that suits blue, so their accents sit higher. */
function yellowness(h: number): number {
  return Math.max(0, Math.cos(((h - 100) * Math.PI) / 180)) ** 3;
}

/** The colour a point shows on the canvas: the hue at a lightness every hue can reach. */
export function pointColor(point: ThemeSeedPoint): string {
  return hex(0.74, 0.02 + point.radius * 0.15, point.hue);
}

export function deriveSeedRoles(seed: ThemeSeed, mode: Mode): Record<SeedRole, string> {
  const surface = seed.points[0]!;
  const accentPoint = seed.points[1] ?? surface;
  const sidebarPoint = seed.points[2];
  const h = surface.hue;
  const cs = surface.radius * SURFACE_CHROMA;
  const ha = accentPoint.hue;
  const ca = 0.02 + accentPoint.radius * 0.2;
  const soft = seed.softness;

  if (mode === 'light') {
    const bgL = 1 - 0.012 * surface.radius - 0.05 * soft;
    const bg = fit(bgL, cs * 0.6, h);
    const elevatedL = bgL + (1 - bgL) * 0.6;
    const accentL = 0.57 + 0.12 * yellowness(ha);
    const accent = fit(accentL, ca, ha);
    const ink = Math.min(cs * 1.4, 0.05);
    const fg = readable(0.29, cs * 0.5, h, bg, 12, true);
    return {
      bg: colorToHex(bg),
      'bg-sidebar': sidebarPoint
        ? hex(bgL - 0.014 - 0.02 * sidebarPoint.radius, sidebarPoint.radius * SIDEBAR_CHROMA, sidebarPoint.hue)
        : hex(bgL - 0.014, cs * 0.8, h),
      'bg-subtle': hex(bgL - 0.018, cs * 0.8, h),
      'bg-muted': hex(bgL - 0.04, cs, h),
      'bg-elevated': hex(elevatedL, cs * 0.4, h),
      'bg-popover': hex(elevatedL, cs * 0.4, h),
      'bg-hover': hex(0.3, ink, h, 0.055),
      'bg-active': hex(0.3, ink, h, 0.09),
      'bg-bubble': hex(bgL - 0.03, Math.min(ca * 0.12, 0.03), ha),
      fg,
      'fg-2': readable(0.44, cs * 0.5, h, bg, 7, true),
      'fg-3': readable(0.51, cs * 0.5, h, bg, 4.5, true),
      'fg-4': hex(0.76, cs * 0.4, h),
      line: hex(0.2, ink, h, 0.08),
      'line-soft': hex(0.2, ink, h, 0.055),
      'line-strong': hex(0.2, ink, h, 0.13),
      primary: hex(0.2, cs * 0.5, h),
      'primary-hover': hex(0.33, cs * 0.5, h),
      'primary-fg': hex(elevatedL, cs * 0.4, h),
      accent: colorToHex(accent),
      'accent-hover': hex(accentL - 0.04, ca, ha),
      'accent-soft': colorToHex([accent[0], accent[1], accent[2], 0.1]),
      'accent-fg': onFill(accent, '#ffffff', fg),
      toast: hex(0.27, cs * 0.6, h),
      'chart-1': colorToHex(accent),
    };
  }

  const bgL = 0.185 + 0.07 * soft;
  const bg = fit(bgL, cs * 0.7, h);
  const bgHex = colorToHex(bg);
  const accentL = 0.7 + 0.08 * yellowness(ha);
  const accent = fit(accentL, ca, ha);
  const ink = Math.min(cs, 0.03);
  return {
    bg: bgHex,
    'bg-sidebar': sidebarPoint
      ? hex(bgL + 0.022, sidebarPoint.radius * SIDEBAR_CHROMA, sidebarPoint.hue)
      : hex(bgL + 0.022, cs * 0.7, h),
    'bg-subtle': hex(bgL + 0.03, cs * 0.7, h),
    'bg-muted': hex(bgL + 0.075, cs * 0.7, h),
    'bg-elevated': hex(bgL + 0.04, cs * 0.7, h),
    'bg-popover': hex(bgL + 0.06, cs * 0.7, h),
    'bg-hover': hex(0.98, ink, h, 0.06),
    'bg-active': hex(0.98, ink, h, 0.1),
    'bg-bubble': hex(bgL + 0.075, Math.min(ca * 0.15, 0.035), ha),
    fg: readable(0.87, cs * 0.4, h, bg, 11, false),
    'fg-2': readable(0.8, cs * 0.4, h, bg, 8, false),
    'fg-3': readable(0.72, cs * 0.4, h, bg, 5, false),
    'fg-4': hex(0.5, cs * 0.4, h),
    line: hex(0.98, ink, h, 0.075),
    'line-soft': hex(0.98, ink, h, 0.05),
    'line-strong': hex(0.98, ink, h, 0.12),
    primary: hex(0.95, cs * 0.4, h),
    'primary-hover': hex(0.87, cs * 0.4, h),
    'primary-fg': bgHex,
    accent: colorToHex(accent),
    'accent-hover': hex(accentL - 0.04, ca, ha),
    'accent-soft': colorToHex([accent[0], accent[1], accent[2], 0.15]),
    'accent-fg': onFill(accent, bgHex, '#ffffff'),
    toast: hex(bgL + 0.12, cs * 0.7, h),
    'chart-1': colorToHex(accent),
  };
}

/**
 * Redraws [palettes] from [next]. A seed role the author has typed over — one that no longer
 * matches what [previous] produced — keeps the author's value. Without a previous seed the canvas
 * is being picked up for the first time and owns every seed role.
 */
export function applySeed(palettes: Palettes, previous: ThemeSeed | undefined, next: ThemeSeed): Palettes {
  const redraw = (mode: Mode): ThemePalette => {
    const current = palettes[mode];
    const before = previous ? deriveSeedRoles(previous, mode) : null;
    const after = deriveSeedRoles(next, mode);
    const out = { ...current };
    for (const role of SEED_ROLES) {
      const typed = before && normalizeThemeColor(current[role]) !== before[role];
      if (!typed) out[role] = after[role];
    }
    return out;
  };
  return { light: redraw('light'), dark: redraw('dark') };
}

function toOklch(value: string | undefined): { l: number; c: number; h: number } | null {
  const color = value ? parseColor(value) : null;
  if (!color) return null;
  const [l, a, b] = toOklab(color);
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** Where a palette without a seed would sit on the canvas, so picking it up starts close by. */
export function inferSeed(palettes: Palettes): ThemeSeed {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const paper = toOklch(palettes.light['bg-muted']);
  const accent = toOklch(palettes.light.accent);
  const surface: ThemeSeedPoint = paper ? { hue: paper.h, radius: clamp(paper.c / SURFACE_CHROMA) } : { hue: 0, radius: 0 };
  const accentPoint: ThemeSeedPoint = accent ? { hue: accent.h, radius: clamp((accent.c - 0.02) / 0.2) } : surface;
  const bg = toOklch(palettes.light.bg);
  const softness = bg ? clamp((1 - 0.012 * surface.radius - bg.l) / 0.05) : 0;
  return normalizeThemeSeed({ points: [surface, accentPoint], softness });
}

/** The next pairing in the harmony cycle, measured from the surface point; the surface stays put. */
export function nextHarmony(seed: ThemeSeed): ThemeSeed {
  const [surface, ...others] = seed.points;
  const cycle = HARMONIES[seed.points.length];
  if (!surface || !cycle) return seed;
  const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  const offsets = others.map((point) => (point.hue - surface.hue + 360) % 360);
  const misfit = (set: number[]) => set.reduce((sum, value, index) => sum + distance(value, offsets[index]!), 0);
  const nearest = cycle.reduce((best, set, index) => (misfit(set) < misfit(cycle[best]!) ? index : best), 0);
  const next = cycle[(nearest + 1) % cycle.length]!;
  return { ...seed, points: [surface, ...others.map((point, index) => ({ ...point, hue: (surface.hue + next[index]!) % 360 }))] };
}

/** One more point: the accent opposite the surface, then a sidebar mirroring the accent. */
export function addSeedPoint(seed: ThemeSeed): ThemeSeed {
  const [surface, accent] = seed.points;
  if (!surface || seed.points.length >= 3) return seed;
  if (!accent) return { ...seed, points: [surface, { hue: (surface.hue + 180) % 360, radius: Math.max(surface.radius, 0.7) }] };
  const offset = (accent.hue - surface.hue + 360) % 360;
  // A mirror of an opposite accent lands on the accent itself; a neighbour reads better there.
  const mirrored = Math.abs(offset - 180) < 20 ? 40 : 360 - offset;
  return { ...seed, points: [surface, accent, { hue: (surface.hue + mirrored) % 360, radius: Math.max(surface.radius, 0.5) }] };
}
