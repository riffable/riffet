import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_TEXT, MAC_MOTION, MOTION_DURATION, MOTION_EASING, SPACE } from '../packages/contracts/src/design-tokens.js';
import { IOS_NATIVE_OVERRIDES, MOBILE_BASE_DIMENSIONS, MOBILE_CODE_TEXT, MOBILE_EASING, MOBILE_IOS_TEXT, MOBILE_IPHONE_DIMENSIONS, MOBILE_MOTION, MOBILE_RIFFET_MOTION, MOBILE_SHARED_MOTION, MOBILE_STYLE_DIMENSIONS, type MobileTextStyle } from '../packages/contracts/src/mobile-styles.js';
import { THEME_DIMENSION_BOUNDS, THEME_MOTION_BOUNDS } from '../packages/contracts/src/theme-design.js';

/**
 * Writes the theme-independent design values (`packages/contracts/src/design-tokens.ts`) into the
 * marked regions of the web stylesheet and the Mac app's controls, so each value has one definition
 * (docs/design/system/foundations.md §11). The regions sit inside the hand-written files on purpose:
 * `gen:theme` and `gen:styles` read the stylesheet, and the Mac project lists its files by hand.
 * Run before those two. `--check` fails when a committed region is stale.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const bezier = (points: readonly number[]) => `cubic-bezier(${points.join(', ')})`;
const textEntries = Object.entries(DESKTOP_TEXT) as [string, readonly [number, number]][];

/** Replaces the text between `// BEGIN GENERATED <name>` and `// END GENERATED <name>` (any comment syntax). */
function fill(text: string, file: string, name: string, open: string, close: string, indent: string, body: string[]): string {
  const begin = `${indent}${open} BEGIN GENERATED ${name} (scripts/gen-design-tokens.ts)${close}`;
  const end = `${indent}${open} END GENERATED ${name}${close}`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start < 0 || stop < start) throw new Error(`gen:tokens: markers for ${name} missing in ${file}`);
  return text.slice(0, start) + [begin, ...body.map((line) => indent + line), end].join('\n') + text.slice(stop + end.length);
}

const css = (file: string, text: string, name: string, body: string[]) => fill(text, file, name, '/*', ' */', '  ', body);
const swift = (file: string, text: string, name: string, body: string[]) => fill(text, file, name, '//', '', '', body);

// The mobile defaults must sit inside the bounds a theme's overrides are held to.
const within = (label: string, values: Record<string, number>, bounds: Record<string, readonly [number, number]>) => {
  for (const [key, value] of Object.entries(values)) {
    const [min, max] = bounds[key]!;
    if (value < min || value > max) throw new Error(`gen:tokens: ${label}.${key} = ${value} is outside [${min}, ${max}]`);
  }
};
within('MOBILE_BASE_DIMENSIONS', MOBILE_BASE_DIMENSIONS, THEME_DIMENSION_BOUNDS);
for (const [style, values] of Object.entries(MOBILE_STYLE_DIMENSIONS)) within(`MOBILE_STYLE_DIMENSIONS.${style}`, values, THEME_DIMENSION_BOUNDS);
within('MOBILE_IPHONE_DIMENSIONS', MOBILE_IPHONE_DIMENSIONS, THEME_DIMENSION_BOUNDS);
within('IOS_NATIVE_OVERRIDES', IOS_NATIVE_OVERRIDES.dimensions, THEME_DIMENSION_BOUNDS);
for (const [label, values] of Object.entries({ MOBILE_MOTION, MOBILE_SHARED_MOTION, MOBILE_RIFFET_MOTION })) within(label, values, THEME_MOTION_BOUNDS);

const kd = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
const kf = (n: number) => `${n}f`;
const kmap = (values: Record<string, number>) => Object.entries(values).map(([key, value]) => `"${key}" to ${kd(value)}`);
const kWeight: Record<number, string> = { 400: 'Normal', 500: 'Medium', 600: 'SemiBold', 700: 'Bold' };
const kText = (style: MobileTextStyle, extra = '') => `TextStyle(fontSize = ${style.size}.sp, lineHeight = ${style.lineHeight}.sp${style.weight ? `, fontWeight = FontWeight.${kWeight[style.weight]}` : ''}${extra})`;
const kList = (name: string, entries: string[], prefix = '') => [`internal val ${name} = ${prefix}mapOf(`, ...entries.map((entry) => `    ${entry},`), ')'];

/** The ios style as the iPhone app draws it: the style's values with the iPhone's own overrides. */
const ios = { ...MOBILE_BASE_DIMENSIONS, ...MOBILE_IPHONE_DIMENSIONS, ...IOS_NATIVE_OVERRIDES.dimensions };
const iosMotion = { ...MOBILE_MOTION, ...MOBILE_SHARED_MOTION };
/** A SwiftUI spring's response for a Compose stiffness (unit mass): one undamped period. */
const response = (stiffness: number) => Math.round((2 * Math.PI / Math.sqrt(stiffness)) * 100) / 100;
const swiftWeight: Record<number, string> = { 400: '.regular', 500: '.medium', 600: '.semibold', 700: '.bold' };
// The iPhone's text roles (RiffetDesign.swift) and the ios style slots they read.
const iosRoles: [role: string, style: MobileTextStyle][] = [
  ['body', MOBILE_IOS_TEXT.bodyLarge],
  ['headline', MOBILE_IOS_TEXT.titleMedium],
  ['barTitle', { ...MOBILE_IOS_TEXT.titleLarge, weight: IOS_NATIVE_OVERRIDES.barTitleWeight }],
  ['label', MOBILE_IOS_TEXT.labelLarge],
  ['caption', MOBILE_IOS_TEXT.bodySmall],
  ['mono', MOBILE_CODE_TEXT.mono],
  ['monoSmall', MOBILE_CODE_TEXT.monoSmall],
];

const outputs: Record<string, (text: string, file: string) => string> = {
  'apps/mobile/shared/src/commonMain/kotlin/riffet/ui/design/MobileStyles.generated.kt': () => [
    '// Generated by scripts/gen-design-tokens.ts from packages/contracts/src/mobile-styles.ts.',
    '// Do not edit by hand: change that file and run `pnpm gen:tokens`.',
    'package riffet.ui.design',
    '',
    'import androidx.compose.animation.core.CubicBezierEasing',
    'import androidx.compose.ui.text.TextStyle',
    'import androidx.compose.ui.text.font.FontFamily',
    'import androidx.compose.ui.text.font.FontWeight',
    'import androidx.compose.ui.unit.sp',
    '',
    ...kList('BaseDesignDimensions', kmap(MOBILE_BASE_DIMENSIONS)),
    ...Object.entries(MOBILE_STYLE_DIMENSIONS).flatMap(([style, values]) => kList(`${style[0]!.toUpperCase()}${style.slice(1)}Dimensions`, kmap(values))),
    ...kList('DefaultMotionTokens', kmap(MOBILE_MOTION)),
    ...kList('RiffetMotionTokens', kmap(MOBILE_RIFFET_MOTION), 'DefaultMotionTokens + '),
    `internal val StandardMotionEasing = CubicBezierEasing(${MOBILE_EASING.standard.map(kf).join(', ')})`,
    // Reading MaterialStyleTypography starts ThemePresets.kt's initialiser,
    // which reaches back for these through RiffetDefaultTypography.
    ...Object.entries(MOBILE_CODE_TEXT).map(([name, style]) => `internal val Mobile${name[0]!.toUpperCase()}${name.slice(1)}Text = ${kText(style, ', fontFamily = FontFamily.Monospace')}`),
    '',
  ].join('\n'),
  'apps/mobile/iosApp/Riffet/Design/RiffetDesign.swift': (text, file) => {
    const indent = (lines: string[], by: string) => lines.map((line) => by + line);
    text = fill(text, file, 'text', '//', '', '    ', [
      'fileprivate var size: CGFloat {',
      '    switch self {',
      ...iosRoles.map(([role, style]) => `    case .${role}: ${style.size}`),
      '    }',
      '}',
      'fileprivate var weight: Font.Weight {',
      '    switch self {',
      ...iosRoles.map(([role, style]) => `    case .${role}: ${swiftWeight[style.weight ?? 400]}`),
      '    }',
      '}',
    ]);
    text = fill(text, file, 'metrics', '//', '', '    ', [
      `static let pageInset: CGFloat = ${ios.pageInset}`,
      `static let groupRadius: CGFloat = ${ios.groupRadius}`,
      `static let settingsRowHeight: CGFloat = ${ios.rowHeight}`,
      `static let composerRadius: CGFloat = ${ios.composerRadius}`,
      `static let sendButton: CGFloat = ${ios.sendButtonSize}`,
      `static let groupInset: CGFloat = ${ios.groupInset}`,
      `static let controlRadius: CGFloat = ${ios.controlRadius}`,
      `static let rowRadius: CGFloat = ${ios.rowRadius}`,
      `static let selectionRadius: CGFloat = ${ios.selectionRadius}`,
      `static let menuRadius: CGFloat = ${ios.menuRadius}`,
      '/// A row\'s symbol tile: its square and corner.',
      `static let iconSlot: CGFloat = ${ios.iconSlot}`,
      `static let iconTileRadius: CGFloat = ${ios.iconTileRadius}`,
      '/// The floating shadow before Liquid Glass: SwiftUI\'s radius is half the Compose blur.',
      `static let floatingShadowRadius: CGFloat = ${ios.floatingShadowRadius / 2}`,
      `static let floatingShadowY: CGFloat = ${ios.floatingShadowOffset}`,
      `static let floatingShadowOpacity: Double = ${iosMotion.floatingShadowOpacity}`,
    ]);
    const [x1, y1, x2, y2] = MOBILE_EASING.shared;
    return fill(text, file, 'motion', '//', '', '    ', indent([
      `static let spatial = Animation.spring(response: ${response(iosMotion.spatialStiffness)}, dampingFraction: ${iosMotion.spatialDamping})`,
      `static let effects = Animation.spring(response: ${response(iosMotion.effectsStiffness)}, dampingFraction: 1)`,
      `static let release = Animation.timingCurve(${x1}, ${y1}, ${x2}, ${y2}, duration: ${iosMotion.medium / 1000})`,
      `static let chevron = Animation.timingCurve(${x1}, ${y1}, ${x2}, ${y2}, duration: ${iosMotion.short / 1000})`,
    ], ''));
  },
  'apps/web/src/styles/index.css': (text, file) => {
    // Tailwind's `text-*` utilities: plain px, which gen:theme reads into the mobile type ladder.
    text = css(file, text, 'text', ['--text-*: initial;', ...textEntries.flatMap(([step, [size, line]]) => [`--text-${step}: ${size}px;`, `--text-${step}--line-height: ${line}px;`])]);
    text = css(file, text, 'theme-easing', [`--ease-out-soft: ${bezier(MOTION_EASING.outSoft)};`]);
    text = css(file, text, 'motion', [
      ...Object.entries(MOTION_EASING).filter(([name]) => name !== 'outSoft').map(([name, points]) => `--ease-${kebab(name)}: ${bezier(points)};`),
      ...Object.entries(MOTION_DURATION).map(([name, ms]) => `--duration-${kebab(name)}: ${ms}ms;`),
    ]);
    // The same ladder at the reader's text size; unlayered, so it wins over the theme layer.
    return css(file, text, 'text-scaled', textEntries.flatMap(([step, [size, line]]) => [`--text-${step}: calc(${size}px * var(--text-scale));`, `--text-${step}--line-height: calc(${line}px * var(--text-scale));`]));
  },
  'apps/macos/Riffet/Theme/Controls.swift': (text, file) => {
    text = swift(file, text, 'motion', [
      '/// The animation tiers (docs/design/macos-native.md 3.1); nothing in the app picks a free duration.',
      'enum Motion {',
      ...Object.entries(MAC_MOTION).flatMap(([tier, motion]) => {
        const seconds = MOTION_DURATION[motion.duration] / 1000;
        const animation = 'spring' in motion
          ? `Animation.${motion.spring}(duration: ${seconds})`
          : `Animation.timingCurve(${MOTION_EASING[motion.curve].join(', ')}, duration: ${seconds})`;
        return [`    /// ${motion.use}`, `    static let ${tier} = ${animation}`];
      }),
      '}',
    ]);
    return swift(file, text, 'space', [
      '/// Spacing steps used everywhere (docs/design/system/foundations.md 3); nothing in the app picks a free number.',
      'enum Space {',
      ...Object.entries(SPACE).map(([step, value]) => `    static let ${step}: CGFloat = ${value}`),
      '}',
    ]);
  },
};

let stale = false;
for (const [path, write] of Object.entries(outputs)) {
  const file = resolve(root, path);
  let current = '';
  try { current = readFileSync(file, 'utf8'); } catch {}
  const next = write(current, path);
  if (next === current) continue;
  if (check) {
    console.error(`gen:tokens: ${path} is stale; run \`pnpm gen:tokens\`.`);
    stale = true;
  } else {
    writeFileSync(file, next);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
