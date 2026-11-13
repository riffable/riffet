/**
 * The design values that do not change with the theme (docs/design/system/foundations.md §11):
 * spacing, the desktop text ladder, and motion durations and curves. This is their one definition;
 * `pnpm gen:tokens` writes them into the web stylesheet and the Mac app, and `--check` fails when
 * either is stale. Colours and shadows change with the theme and stay in apps/web/src/styles/index.css.
 */

/** Spacing steps, pt / px (foundations §3). Mac `Space.*`; the web uses Tailwind's 4px unit. */
export const SPACE = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * The desktop text ladder: size and line height, px on the web and pt on the Mac (foundations §2.2).
 * The web's `text-*` utilities; scaled by the reader's text size (`--text-scale`).
 */
export const DESKTOP_TEXT = {
  '2xs': [11, 16],
  xs: [12, 18],
  sm: [13, 20],
  base: [14, 22],
  lg: [16, 24],
  xl: [18, 26],
  '2xl': [22, 30],
} as const satisfies Record<string, readonly [size: number, lineHeight: number]>;

/** Motion durations, ms (foundations §7.1). Leaving runs about 30% shorter than the matching enter. */
export const MOTION_DURATION = {
  fast: 150,
  base: 200,
  medium: 250,
  slow: 300,
  exitFast: 100,
  exitBase: 140,
} as const;

/** Motion curves, cubic-bezier control points (foundations §7.2). */
export const MOTION_EASING = {
  /** A change of state in place. */
  standard: [0.2, 0, 0, 1],
  /** Entering. */
  decelerate: [0.05, 0.7, 0.1, 1],
  /** Leaving. */
  accelerate: [0.3, 0, 0.8, 0.15],
  /** A bottom sheet. */
  sheet: [0.32, 0.72, 0, 1],
  /** An image growing to its place, a panel appearing. */
  outSoft: [0.2, 0.7, 0.2, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/**
 * The Mac's three animation tiers (docs/design/macos-native.md §3.1): SwiftUI springs whose
 * perceived duration is a web duration, so a hover on the Mac takes as long as on the web.
 */
export const MAC_MOTION = {
  fast: { spring: 'snappy', duration: 'fast', use: 'Hover, press, a check, an icon changing shape.' },
  standard: { spring: 'snappy', duration: 'base', use: 'Cross-fades, menus and popovers, the selection pill sliding.' },
  expressive: { spring: 'smooth', duration: 'slow', use: "Panels, a sidebar's content, sheets, the search panel." },
} as const satisfies Record<string, { spring: 'snappy' | 'smooth'; duration: keyof typeof MOTION_DURATION; use: string }>;
