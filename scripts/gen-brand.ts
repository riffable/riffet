import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * Draws the Riffet mark into every icon file the apps ship: the web favicon and PWA icons, the
 * macOS and iOS app icons, and Android's adaptive launcher layers. Output is committed; run
 * `pnpm gen:brand` after changing anything here.
 *
 * The mark is a solid side-view horse head on a 24-unit grid with a three-tooth mane. The head is
 * the front colour with a round eye cut out of it, so it shows whatever is behind the mark; the
 * mane is the accent and sits behind the head. Both are filled and stroked in their own colour
 * (head 1 unit, mane 0.6) so the corners come out round. The mane is the cubic neck curve's
 * offsets, a sawtooth of three rounded teeth, baked into `MANE` below. `lib/app-icon.ts` (web),
 * `RiffetIcons` (Android) and `BrandMark` (macOS, iOS) carry copies of these paths. Colours, the wordmark and the lockup rule are in `docs/brand/README.md`.
 */

/** The head, then the mane behind it; both are drawn with a round-join stroke in their own fill. */
const BODY = 'M6 21C5.6 14.4 6.6 9 8.8 5.8L9.4 2.6L11.2 5.4C14.4 6.6 17.4 8.4 20 10.8c1.3 1.2 0.7 3.4 -1 3.4c-1.4 0 -3 -0.3 -4.4 -0.6c-1.4 -0.3 -2.3 0.3 -2.4 1.6c-0.1 2 0.2 4 0.8 5.8Z';
const MANE = 'M8.77 6.2Q6.51 6.56 5.15 8.55L7.76 8.17Q5.43 9.17 4.26 11.65L6.94 10.68Q4.72 12.24 3.82 15.1L6.42 13.42Z';
/** The eye, a circle at (12.5, 8.2) r 1 as a subpath: appended to `BODY` and filled even-odd it is a hole. */
const EYE = 'M11.5 8.2a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z';
const BODY_STROKE = 1;
const MANE_STROKE = 0.6;

/**
 * The mark's visual bounds are x 3.5-21.2, y 2.1-21.5 on the grid, 19.4 tall. Tiles centre on the
 * optical centre rather than the grid's: the head leans right and sits a little high. No ink is
 * farther than `REACH` from it, which is what a circular safe zone has to contain.
 */
type Point = readonly [number, number];
const HEIGHT = 19.4;
const CENTER: Point = [12.6, 11.8];
const REACH = 11.82;

/** The tile is the default theme's `--primary`; on it the accent is the dark theme's `--accent`. */
const INK = '#15171a';
const PAPER = '#f4f2ee';
const ACCENT_ON_PAPER = '#3867f0';

/**
 * The app-icon accents a device can choose, all drawn on the dark tile. `id` is the contract every
 * client keys on: the stored preference, `AppIcon-<id>` (macOS imageset, iOS alternate icon) and
 * `ic_launcher_<id>` (Android activity-alias). The first is the default and keeps the plain names.
 */
const VARIANTS = [
  { id: 'blue', accent: '#5b8cff' },
  { id: 'purple', accent: '#a78bfa' },
  { id: 'magenta', accent: '#e879f9' },
  { id: 'pink', accent: '#f472b6' },
  { id: 'red', accent: '#f87171' },
  { id: 'orange', accent: '#f5a142' },
  { id: 'yellow', accent: '#facc15' },
  { id: 'lime', accent: '#a3e635' },
  { id: 'green', accent: '#3fcf8e' },
  { id: 'cyan', accent: '#22d3ee' },
  { id: 'graphite', accent: '#9aa0a8' },
  { id: 'white', accent: '#f4f4f2' },
] as const;
type Variant = (typeof VARIANTS)[number];
const DEFAULT = VARIANTS[0];
const ACCENT_ON_INK = DEFAULT.accent;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The mark placed by `scale` with its optical centre on (cx, cy); `body` and `mane` are fills. */
function mark(scale: number, cx: number, cy: number, body: string, mane: string): string {
  const n = (v: number) => +v.toFixed(3);
  const at = scale === 1 && cx === CENTER[0] && cy === CENTER[1]
    ? '' : ` transform="translate(${n(cx - CENTER[0] * scale)} ${n(cy - CENTER[1] * scale)}) scale(${n(scale)})"`;
  return `<g${at}>`
    + `<path d="${MANE}" fill="${mane}" stroke="${mane}" stroke-width="${MANE_STROKE}" stroke-linejoin="round"/>`
    + `<path d="${BODY}${EYE}" fill="${body}" fill-rule="evenodd"/>`
    + `<path d="${BODY}" fill="none" stroke="${body}" stroke-width="${BODY_STROKE}" stroke-linejoin="round"/></g>`;
}

/** The mark's height as `ratio` of a tile of `size`, as a scale. */
const fit = (size: number, ratio: number) => size * ratio / HEIGHT;
/**
 * The horse's share of a small tile's height (PWA, the pickers): larger than the big icons', which
 * have room to breathe. The favicon and the pickers' 32-unit tile use scale 1.06, the same 64%.
 */
const TILE_FILL = 0.64;
const ANDROID_SCALE = 2.7;

/**
 * The wordmark "Riffet" on a 22-unit line: stroke 2.8, round caps and joins, a capital R whose leg
 * leaves the middle of the bowl, a dotted i, two f's each with its own crossbar, an e and a hooked
 * t. The gap between neighbouring strokes is a uniform 5.4, which fixes the stems' x positions.
 */
const WORD_STROKE = 2.8;
const WORD_STEMS = { i: 15.4, f1: 23, f2: 32.8, e: 40.4, t: 60 };
const WORD_W = 65.4;
function wordmark(ink: string): string {
  const { i, f1, f2, e, t } = WORD_STEMS;
  const f = (x: number) => `<path d="M${x} 20V6a4 4 0 0 1 4-4M${+(x - 2.2).toFixed(1)} 8h4.4"/>`;
  return `<g fill="none" stroke="${ink}" stroke-width="${WORD_STROKE}" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M0 20V2h5a4.5 4.5 0 0 1 0 9H0M3.6 11l6.4 9"/><path d="M${i} 8v12"/>${f(f1)}${f(f2)}`
    + `<path d="M${e} 14h12a6 6 0 1 0-1.76 4.24"/><path d="M${t} 2v14a4 4 0 0 0 4 4M${t - 2.2} 8h4.4"/></g>`
    + `<circle cx="${i}" cy="2.6" r="${+(WORD_STROKE * 0.62).toFixed(3)}" fill="${ink}"/>`;
}

/**
 * The horse and the wordmark side by side. The wordmark is 0.6125 of the mark's scale, 27.25 units
 * from the horse's origin, and centred vertically on the horse's bounding box (y 2.1-21.5).
 */
const WORD_SCALE = 0.6125;
const LOCKUP_GAP = 27.25;
const LOCKUP_W = +(LOCKUP_GAP + WORD_W * WORD_SCALE - 1.6).toFixed(2);
function lockup(ink: string, mane: string): string {
  const y = +((2.1 + 21.5) / 2 - 11 * WORD_SCALE).toFixed(4);
  return `${mark(1, ...CENTER, ink, mane)}<g transform="translate(${LOCKUP_GAP} ${y}) scale(${WORD_SCALE})">${wordmark(ink)}</g>`;
}

/**
 * Apple's continuous-corner rounded rectangle (the app icon "squircle"): each corner eases in over
 * 1.53 r instead of meeting the edge as a circular arc.
 */
function squircle(x: number, y: number, size: number, r: number): string {
  const k = [1.52866483, 1.08849323, 0.86840689, 0.63149399, 0.074911, 0.37282392, 0.16905899].map((n) => n * r);
  const [a, b, c, d, e, f, g] = k as [number, number, number, number, number, number, number];
  const X = x + size, Y = y + size;
  const n = (v: number) => +v.toFixed(2);
  const C = (...p: number[]) => `C${p.map(n).join(' ')}`;
  return [
    `M${n(x + a)} ${n(y)}H${n(X - a)}`,
    C(X - b, y, X - c, y, X - d, y + e), C(X - f, y + g, X - g, y + f, X - e, y + d), C(X, y + c, X, y + b, X, y + a),
    `V${n(Y - a)}`,
    C(X, Y - b, X, Y - c, X - e, Y - d), C(X - g, Y - f, X - f, Y - g, X - d, Y - e), C(X - c, Y, X - b, Y, X - a, Y),
    `H${n(x + a)}`,
    C(x + b, Y, x + c, Y, x + d, Y - e), C(x + f, Y - g, x + g, Y - f, x + e, Y - d), C(x, Y - c, x, Y - b, x, Y - a),
    `V${n(y + a)}`,
    C(x, y + b, x, y + c, x + e, y + d), C(x + g, y + f, x + f, y + g, x + d, y + e), C(x + c, y, x + b, y, x + a, y),
    'Z',
  ].join('');
}

/**
 * The large app-icon artwork: a dark tile lit slightly from above, a white head and an accent mane,
 * the horse 62% of the tile tall. `tile` is the tile's own markup, so macOS (floating squircle with
 * a shadow) and iOS (full bleed, the system masks it) share the rest; iOS's dark and tinted
 * appearances pass no tile and let the system draw the background, which shows through the eye.
 */
function artwork(size: number, tile: ((fill: string) => string) | null, mane: string, body = '#ffffff'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d33"/><stop offset="1" stop-color="#111315"/></linearGradient>
  <filter id="drop" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="${size * 0.01}" stdDeviation="${size * 0.01}" flood-color="#000" flood-opacity="0.3"/></filter>
</defs>
${tile?.('url(#tile)') ?? ''}
${mark(fit(size, 0.62), size / 2, size / 2, body, mane)}
</svg>`;
}

/** macOS: the 824-point squircle on the 1024 grid, floating with a soft shadow; transparent around it. */
function macIcon(variant: Variant): string {
  return artwork(1024, (fill) => `<path d="${squircle(100, 100, 824, 185.4)}" fill="${fill}" filter="url(#drop)"/>`
    + `<path d="${squircle(100.75, 100.75, 822.5, 184.9)}" fill="none" stroke="#fff" stroke-opacity="0.09" stroke-width="1.5"/>`, variant.accent);
}

/**
 * iOS, one image per appearance. Light is full bleed and opaque (the system applies the mask);
 * dark and tinted are the mark alone on transparency over the system's own dark background. The
 * tinted one is grey: the system maps luminance to the user's tint, so the mane is a mid grey to
 * stay distinct from the white head.
 */
const IOS_APPEARANCES = [
  { suffix: '', luminosity: null, draw: (v: Variant) => artwork(1024, (fill) => `<rect width="1024" height="1024" fill="${fill}"/>`, v.accent) },
  { suffix: '-dark', luminosity: 'dark', draw: (v: Variant) => artwork(1024, null, v.accent) },
  { suffix: '-tinted', luminosity: 'tinted', draw: () => artwork(1024, null, '#8c8c8c') },
] as const;

function iosIconSet(): string {
  const images = IOS_APPEARANCES.map(({ suffix, luminosity }) => ({
    ...(luminosity ? { appearances: [{ appearance: 'luminosity', value: luminosity }] } : {}),
    filename: `icon${suffix}.png`, idiom: 'universal', platform: 'ios', size: '1024x1024',
  }));
  return JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) + '\n';
}

/** macOS runtime icon (`NSApp.applicationIconImage`): one 1024 image, the 512-point @2x. */
const macImageSet = JSON.stringify({ images: [{ filename: 'icon.png', idiom: 'universal', scale: '2x' }], info: { author: 'xcode', version: 1 } }, null, 2) + '\n';

/** PWA "any" icon: the flat tile with its own continuous corners. */
function pwaIcon(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<path d="${squircle(0, 0, size, size * 0.225)}" fill="${INK}"/>${mark(fit(size, TILE_FILL), size / 2, size / 2, '#fff', ACCENT_ON_INK)}</svg>`;
}

/** PWA maskable icon: full bleed, the farthest ink 0.39 of the size from the centre, inside the 80% safe circle. */
function maskableIcon(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" fill="${INK}"/>${mark(size * 0.39 / REACH, size / 2, size / 2, '#fff', ACCENT_ON_INK)}</svg>`;
}

/**
 * Avatar (GitHub, npm, chat apps): full bleed and opaque, since each site applies its own rounded
 * or circular mask; the farthest ink 0.36 of the size from the centre keeps it clear of a circle.
 */
function avatar(size: number, tile: string, body: string, mane: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" fill="${tile}"/>${mark(size * 0.36 / REACH, size / 2, size / 2, body, mane)}</svg>`;
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${INK}"/>${mark(1.06, 16, 16, '#fff', ACCENT_ON_INK)}</svg>\n`;

/** The standalone files in `docs/brand`: the mark on its grid, the wordmark, and the two side by side. */
const docsMark = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.6 -0.2 24 24">${mark(1, ...CENTER, body, ACCENT_ON_PAPER)}</svg>\n`;
const docsWordmark = (ink: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.6 -1 ${WORD_W + 1.8} 23">${wordmark(ink)}</svg>\n`;
const docsLockup = (ink: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2.6 0.8 ${LOCKUP_W} 22.4">${lockup(ink, ACCENT_ON_PAPER)}</svg>\n`;

/**
 * Adaptive icon layer: a 108dp canvas the launcher crops to the centre 66dp. The mark is scaled
 * 2.7x with its optical centre on the canvas centre; its farthest ink then sits 31.9dp out, inside
 * the 33dp safe circle. The head is two paths, the fill with the eye cut out even-odd and the
 * outline stroke, since a stroke on the fill's path would outline the eye too.
 */
function androidLayer(comment: string, mane: string, body: string): string {
  const path = (data: string, attrs: string[]) => `        <path
            android:pathData="${data}"
${attrs.map((attr) => `            ${attr}`).join('\n')} />`;
  const fill = (color: string) => `android:fillColor="${color.toUpperCase()}"`;
  const stroke = (color: string, width: number) => [`android:strokeColor="${color.toUpperCase()}"`, `android:strokeWidth="${width}"`, 'android:strokeLineJoin="round"'];
  const shapes = [
    path(MANE, [fill(mane), ...stroke(mane, MANE_STROKE)]),
    path(BODY + EYE, [fill(body), 'android:fillType="evenOdd"']),
    path(BODY, stroke(body, BODY_STROKE)),
  ].join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  ${comment}
  Generated by scripts/gen-brand.ts.
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:scaleX="${ANDROID_SCALE}"
        android:scaleY="${ANDROID_SCALE}"
        android:translateX="${+(54 - CENTER[0] * ANDROID_SCALE).toFixed(2)}"
        android:translateY="${+(54 - CENTER[1] * ANDROID_SCALE).toFixed(2)}">
${shapes}
    </group>
</vector>
`;
}

/** An adaptive icon sharing the default's background and themed layer; only the foreground differs. */
function adaptiveIcon(foreground: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/gen-brand.ts. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/${foreground}" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;
}

function write(path: string, content: string | Buffer) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${path}`);
}

/** Rasterises at the target size (not by downscaling a large render), so small sizes stay sharp. */
async function png(svg: string, size: number, opaque = false): Promise<Buffer> {
  const intrinsic = Number(/width="(\d+)"/.exec(svg)?.[1]);
  const image = sharp(Buffer.from(svg), { density: 72 * size / intrinsic }).resize(size, size);
  return (opaque ? image.flatten({ background: INK }) : image).png({ compressionLevel: 9 }).toBuffer();
}

write('apps/web/public/favicon.svg', favicon);
for (const [suffix, ink] of [['', INK], ['-dark', PAPER]] as const) {
  write(`docs/brand/mark${suffix}.svg`, docsMark(ink));
  write(`docs/brand/wordmark${suffix}.svg`, docsWordmark(ink));
  write(`docs/brand/lockup${suffix}.svg`, docsLockup(ink));
}
for (const [suffix, tile, body, mane] of [['', PAPER, INK, ACCENT_ON_PAPER], ['-dark', INK, '#fff', ACCENT_ON_INK]] as const) {
  write(`docs/brand/avatar${suffix}.svg`, avatar(1024, tile, body, mane) + '\n');
  write(`docs/brand/avatar${suffix}.png`, await png(avatar(1024, tile, body, mane), 1024, true));
}
write('apps/web/public/icons/icon-192.png', await png(pwaIcon(192), 192));
write('apps/web/public/icons/icon-512.png', await png(pwaIcon(512), 512));
write('apps/web/public/icons/maskable-512.png', await png(maskableIcon(512), 512));

const macAssets = 'apps/macos/Riffet/Resources/Assets.xcassets';
for (const points of [16, 32, 128, 256, 512]) {
  write(`${macAssets}/AppIcon.appiconset/icon_${points}.png`, await png(macIcon(DEFAULT), points));
  write(`${macAssets}/AppIcon.appiconset/icon_${points}@2x.png`, await png(macIcon(DEFAULT), points * 2));
}

const iosAssets = 'apps/mobile/iosApp/Riffet/Resources/Assets.xcassets';
const res = 'apps/mobile/androidApp/src/main/res';
for (const variant of VARIANTS) {
  const named = variant === DEFAULT ? '' : `-${variant.id}`;
  const iosSet = `${iosAssets}/AppIcon${named}.appiconset`;
  for (const { suffix, luminosity, draw } of IOS_APPEARANCES) {
    write(`${iosSet}/icon${suffix}.png`, await png(draw(variant), 1024, !luminosity));
  }
  write(`${iosSet}/Contents.json`, iosIconSet());
  if (variant === DEFAULT) continue;

  write(`${macAssets}/AppIcon-${variant.id}.imageset/icon.png`, await png(macIcon(variant), 1024));
  write(`${macAssets}/AppIcon-${variant.id}.imageset/Contents.json`, macImageSet);
  write(`${res}/drawable/ic_launcher_foreground_${variant.id}.xml`, androidLayer(
    `The ${variant.id} app-icon variant's foreground, picked in Settings through its activity-alias.`,
    variant.accent, '#ffffff',
  ));
  write(`${res}/mipmap-anydpi-v26/ic_launcher_${variant.id}.xml`, adaptiveIcon(`ic_launcher_foreground_${variant.id}`));
}

write(`${res}/drawable/ic_launcher_foreground.xml`, androidLayer(
  'The Riffet mark (apps/web/src/components/BrandMark.tsx) on the adaptive-icon canvas.',
  ACCENT_ON_INK, '#ffffff',
));
write(`${res}/drawable/ic_launcher_monochrome.xml`, androidLayer(
  'The themed-icon layer (Android 13+): the same mark as one alpha mask, tinted by the system.',
  '#ffffff', '#ffffff',
));
