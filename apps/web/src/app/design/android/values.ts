import { MOBILE_BASE_DIMENSIONS, MOBILE_EASING, MOBILE_MOTION, MOBILE_RIFFET_MOTION, MOBILE_STYLE_DIMENSIONS } from '@contracts';

/**
 * What the Android chapters draw from (docs/design/system/android.md). Sizes and motion are read
 * from `packages/contracts/src/mobile-styles.ts`, the same definition `pnpm gen:tokens` writes into
 * Kotlin. Recipes and type are Kotlin code (`ui/design/ThemePresets.kt`), so they are copied here:
 * a change to a preset is copied to this file.
 */
export const ANDROID_STYLE_IDS = ['riffet', 'material3'] as const;
export type AndroidStyleId = (typeof ANDROID_STYLE_IDS)[number];

export type Dimensions = typeof MOBILE_BASE_DIMENSIONS;
export type Motion = typeof MOBILE_MOTION;

export interface TextStyle { size: number; line: number; weight: 400 | 500 | 600 | 700 }

/** The roles the chapters show, each style's value: Material 3's scale with tracking removed, then the style's changes. */
export interface TypeScale { body: TextStyle; label: TextStyle; menu: TextStyle; caption: TextStyle; barTitle: TextStyle; largeTitle: TextStyle; dialogTitle: TextStyle; mono: TextStyle }

/** The recipe fields that change how a style looks, from `ComponentRecipes` and `DesignVariants`. */
export interface Recipes {
  /** Which implementation draws buttons. */
  buttons: 'material' | 'shared';
  segments: 'connected' | 'sliding';
  secondaryButtons: 'tonal' | 'plain';
  navigation: 'flat' | 'floating';
  indicator: 'fill' | 'capsule';
  homeTabs: 'underline';
  /** Lines between the rows of a group. */
  dividers: boolean;
  /** A chosen option is marked at the row's end rather than by its fill. */
  selectionAtEnd: boolean;
  /** Group titles in the accent colour. */
  accentSections: boolean;
  card: 'tonal' | 'elevated';
  dialogs: 'material' | 'shared';
  press: 'ripple' | 'highlight';
}

export interface AndroidStyle { id: AndroidStyleId; dimensions: Dimensions; motion: Motion; easing: readonly number[]; type: TypeScale; recipes: Recipes }

const text = (size: number, line: number, weight: TextStyle['weight'] = 400): TextStyle => ({ size, line, weight });

/** Material 3's type scale as `MaterialStyleTypography` maps it. */
const MATERIAL_TYPE: TypeScale = {
  body: text(16, 24), label: text(14, 20, 500), menu: text(14, 20), caption: text(12, 16),
  barTitle: text(22, 28, 500), largeTitle: text(32, 40, 500), dialogTitle: text(24, 32), mono: text(14, 22),
};

const MATERIAL_RECIPES: Recipes = {
  buttons: 'material', segments: 'connected', secondaryButtons: 'tonal', navigation: 'flat', indicator: 'fill', homeTabs: 'underline',
  dividers: false, selectionAtEnd: false, accentSections: true, card: 'tonal', dialogs: 'material',
  press: 'ripple',
};

const merge = <T extends object>(base: T, changes: Partial<T>): T => ({ ...base, ...changes });
const dimensions = (id: AndroidStyleId): Dimensions => merge(MOBILE_BASE_DIMENSIONS, id === 'material3' ? {} : MOBILE_STYLE_DIMENSIONS[id]);

export const ANDROID_STYLES: readonly AndroidStyle[] = [
  {
    id: 'riffet', dimensions: dimensions('riffet'), motion: merge(MOBILE_MOTION, MOBILE_RIFFET_MOTION), easing: MOBILE_EASING.standard,
    type: merge(MATERIAL_TYPE, { label: text(15, 20, 500), menu: text(15, 20), barTitle: text(20, 26, 500), largeTitle: text(28, 34, 500), dialogTitle: text(18, 26, 500) }),
    recipes: merge(MATERIAL_RECIPES, {
      buttons: 'shared', segments: 'sliding', secondaryButtons: 'plain', navigation: 'floating', indicator: 'capsule',
      dividers: true, selectionAtEnd: true, accentSections: false, card: 'elevated', dialogs: 'shared', press: 'highlight',
    }),
  },
  {
    id: 'material3', dimensions: dimensions('material3'), motion: MOBILE_MOTION, easing: MOBILE_EASING.standard,
    type: MATERIAL_TYPE, recipes: MATERIAL_RECIPES,
  },
];

/** The page and navigation sizes that are Kotlin constants rather than style tokens (android.md §3). */
export const ANDROID = {
  /** `PageHost`: a back swipe returns past a third of the width, or past 5% at 500 dp/s. */
  back: { distance: 0.33, flick: 0.05, velocity: 500, previewScale: 0.9 },
  /** `SheetRecipe` and `MenuRecipe`: the most of the screen's height a sheet or menu takes. */
  sheetHeight: 0.7,
  /** The phone the figures are drawn on, in dp. */
  phone: { width: 360, height: 640, status: 24, gesture: 16 },
} as const;
