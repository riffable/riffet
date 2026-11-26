/**
 * The mobile interface styles' default values (docs/design/system/foundations.md §11; docs/THEMES.md
 * §8–9): sizes, radii and floating shadows in dp, motion in ms and spring terms, and the iPhone app's
 * type scale. Their one definition: `pnpm gen:tokens` writes the Android styles' into Kotlin and the
 * iPhone's own (`MOBILE_IPHONE_DIMENSIONS`, `MOBILE_SHARED_MOTION`, `MOBILE_IOS_TEXT`) into the iPhone app (docs/IOS.md). A theme's `design` may still override any of
 * them within `THEME_DIMENSION_BOUNDS` / `THEME_MOTION_BOUNDS`. Component recipes (which component a
 * style draws) stay in `ThemePresets.kt`: they are code, not values.
 */
import type { ThemeDimension, ThemeMotion } from './theme-design.js';

type Dimensions = Record<ThemeDimension, number>;
type Motion = Record<ThemeMotion, number>;

/** Every style starts from these. */
export const MOBILE_BASE_DIMENSIONS: Dimensions = {
  pageInset: 16, groupInset: 16, sectionGap: 20, rowPadding: 16, rowHeight: 52, rowSubtitleHeight: 64,
  iconSize: 24, smallIconSize: 18, iconSlot: 30, iconTileRadius: 8, controlHeight: 48, controlInset: 12,
  groupRadius: 20, menuRadius: 12, controlRadius: 12, rowRadius: 12, selectionRadius: 8, composerRadius: 20,
  barHeight: 64, tabBarHeight: 64, tabBarInset: 0, tabBarBottomInset: 0, drawerWidth: 304, drawerMinGap: 56,
  menuMinWidth: 200, menuMaxWidth: 360, menuRowHeight: 48, menuGroupGap: 8, hairlineWidth: 1, focusWidth: 2,
  alertWidth: 280, sheetMaxWidth: 560, dialogInset: 24, inputMinHeight: 48, inputInset: 12, segmentedHeight: 40,
  switchWidth: 50, switchHeight: 30, switchThumbSize: 26, sliderTrackHeight: 16, sliderThumbSize: 28,
  sendButtonSize: 40, composerMinHeight: 96, composerMaxHeight: 240,
  floatingShadowRadius: 6, floatingShadowLiftedRadius: 12, floatingShadowOffset: 2, floatingShadowSpread: 0,
  buttonIconSize: 20, contentMaxWidth: 840, pageTitleGap: 16,
};

/** The Android styles' changes to the base; material3 has none. */
export const MOBILE_STYLE_DIMENSIONS = {
  // Riffet (docs/design/system/android.md §10): the web's four radius tiers scaled for touch, lighter
  // icons beside regular-weight rows, and one wide soft shadow under the things that float.
  riffet: {
    iconSize: 22, smallIconSize: 16, buttonIconSize: 18, iconSlot: 28, sectionGap: 24, pageTitleGap: 8,
    groupRadius: 16, menuRadius: 14, controlRadius: 12, rowRadius: 10, selectionRadius: 8, composerRadius: 24,
    barHeight: 56, tabBarHeight: 56, tabBarInset: 16, tabBarBottomInset: 8, dialogInset: 20, menuGroupGap: 6,
    segmentedHeight: 36, sendButtonSize: 36,
    switchWidth: 46, switchHeight: 28, switchThumbSize: 24, sliderTrackHeight: 4, sliderThumbSize: 22,
    floatingShadowRadius: 18, floatingShadowLiftedRadius: 28, floatingShadowOffset: 6, floatingShadowSpread: -6,
  },
} as const satisfies Record<string, Partial<Dimensions>>;

/** The iPhone app's changes to the base (before `IOS_NATIVE_OVERRIDES`); Android does not read them. */
export const MOBILE_IPHONE_DIMENSIONS = {
  iconSize: 22, sliderTrackHeight: 4,
  groupRadius: 12, menuRadius: 10, controlRadius: 10, rowRadius: 8, selectionRadius: 6, composerRadius: 14,
  barHeight: 56, tabBarHeight: 58, tabBarInset: 18, tabBarBottomInset: 8, alertWidth: 270, dialogInset: 16,
  segmentedHeight: 34, sendButtonSize: 36, menuGroupGap: 6,
  floatingShadowRadius: 14, floatingShadowLiftedRadius: 22, floatingShadowOffset: 4, floatingShadowSpread: -3,
} as const satisfies Partial<Dimensions>;

/** Material motion: material3. */
export const MOBILE_MOTION: Motion = {
  pageEnter: 300, pageExit: 200, coveredPageShift: 0.08, coveredPageDim: 0.16, pressOpacity: 0.8, disabledOpacity: 0.38,
  floatingShadowOpacity: 0.12, popScale: 0.8, sharedAxisFraction: 1 / 6,
  short: 150, medium: 250, long: 350, exit: 220,
  settleDamping: 1, settleStiffness: 550, spatialDamping: 0.9, spatialStiffness: 700, effectsStiffness: 1600,
};

/** The iPhone app's softer motion, as changes to `MOBILE_MOTION`. */
export const MOBILE_SHARED_MOTION = {
  pageEnter: 350, pageExit: 250, coveredPageShift: 0.25, coveredPageDim: 0.12, pressOpacity: 0.55, popScale: 0.94,
  sharedAxisFraction: 0.25, short: 180, medium: 280, exit: 250,
  settleStiffness: 450, spatialDamping: 0.86, spatialStiffness: 550,
} as const satisfies Partial<Motion>;

/**
 * The riffet style's motion, as changes to `MOBILE_MOTION`: a spatial spring that lands with a slight
 * overshoot (things that move have weight), quick colour and opacity changes, and a page that shifts
 * a little under the one covering it.
 */
export const MOBILE_RIFFET_MOTION = {
  pageEnter: 320, pageExit: 220, coveredPageShift: 0.12, coveredPageDim: 0.1, pressOpacity: 0.6, popScale: 0.92,
  sharedAxisFraction: 0.12, floatingShadowOpacity: 0.1, short: 160, medium: 260, long: 360, exit: 200,
  settleStiffness: 500, spatialDamping: 0.82, spatialStiffness: 520, effectsStiffness: 1400,
} as const satisfies Partial<Motion>;

/** Tween curves: Material's standard; the shared (CSS `ease`) curve of the iPhone app. */
export const MOBILE_EASING = {
  standard: [0.2, 0, 0, 1],
  shared: [0.25, 0.1, 0.25, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export interface MobileTextStyle { size: number; lineHeight: number; weight?: 400 | 500 | 600 | 700 }

/**
 * The iPhone app's type scale, in Material 3's slots (`bodyLarge` is body, `labelLarge` label, `bodySmall`
 * caption, `titleLarge` the bar title, `titleMedium` the headline, `headlineLarge` the large title).
 */
export const MOBILE_IOS_TEXT = {
  headlineLarge: { size: 34, lineHeight: 41, weight: 700 },
  titleLarge: { size: 17, lineHeight: 24, weight: 500 },
  titleMedium: { size: 16, lineHeight: 24, weight: 500 },
  bodyLarge: { size: 16, lineHeight: 22 },
  bodyMedium: { size: 13, lineHeight: 18 },
  bodySmall: { size: 13, lineHeight: 18 },
  labelLarge: { size: 15, lineHeight: 20, weight: 500 },
} as const satisfies Record<string, MobileTextStyle>;

/** Code in every mobile style: blocks and inline code; commands and paths in tool rows. */
export const MOBILE_CODE_TEXT = {
  mono: { size: 14, lineHeight: 22 },
  monoSmall: { size: 13, lineHeight: 20 },
} as const satisfies Record<string, MobileTextStyle>;

/**
 * Where the iPhone app departs from `MOBILE_IPHONE_DIMENSIONS`, and why. Everything else it draws
 * from those.
 */
export const IOS_NATIVE_OVERRIDES = {
  dimensions: {
    // Liquid Glass shapes are concentric with the display's corners: the composer and cards round
    // further than the Compose imitation does.
    composerRadius: 24,
    groupRadius: 16,
  },
  /** Navigation titles in the system's own weight, so a drawn title matches the bar's. */
  barTitleWeight: 600,
} as const satisfies { dimensions: Partial<Dimensions>; barTitleWeight: number };
