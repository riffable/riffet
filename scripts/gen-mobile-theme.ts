import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_A_COLOR_ROLE, colorRoleNames, parseStylesheet } from './theme-blocks';
import { colorToHex, parseColor, THEME_ANSI_KEYS, THEME_ROLES, WEB_BUILTIN_THEMES } from '../packages/contracts/src/theme.js';
import { BUILTIN_CODE_THEME_IDS, CODE_THEME_ROLES, DEFAULT_CODE_THEME_ID, UI_THEME_DEFAULT_CODE_THEME } from '../packages/contracts/src/code-theme.js';
import { BUILTIN_ANSI } from './theme-ansi';
import { BUILTIN_CODE_THEMES } from './code-themes';
import { themeContrastFailures } from './check-theme-contrast';

/**
 * Generates the Compose Multiplatform theme, and the macOS app's palette, from the web's stylesheet.
 *
 * `apps/web/src/styles/index.css` is the single source of design tokens. Hand-copying them into
 * Kotlin would drift the moment either side is edited, so the values are parsed out of the CSS and
 * emitted as Kotlin. The generated file is committed (the Gradle build then needs no Node), and
 * `--check` lets CI fail when it is stale.
 *
 * Only what Compose can express is generated. The `--shadow-*` tokens are multi-layer CSS box
 * shadows; a mobile style draws its own floating shadow (`floatingShadow*` in ThemePresets.kt,
 * docs/design/system/foundations.md §6), so they are not emitted. The Mac reads them through
 * `gen:styles`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cssPath = resolve(root, 'apps/web/src/styles/index.css');
const defaultOut = resolve(root, 'apps/mobile/shared/src/commonMain/kotlin/riffet/theme/RiffetTheme.kt');
const outPath = resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? defaultOut);
const packageName = process.argv.find((arg) => arg.startsWith('--package='))?.slice(10) ?? 'riffet.theme';
const checkOnly = process.argv.includes('--check');

const parsed = parseStylesheet(readFileSync(cssPath, 'utf8'));

/** `--a-b-2: v` → `aB2`. Trailing numeric segments keep their digits so `--fg-2` and `--fg` differ. */
function camel(name: string): string {
  const parts = name.replace(/^--/, '').split('-').filter(Boolean);
  return parts.map((part, index) => index === 0 ? part : part[0]!.toUpperCase() + part.slice(1)).join('');
}

/** Kotlin rejects identifiers starting with a digit, which `--text-2xs` and `--radius-2xl` produce. */
function identifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '`' + name + '`';
}

const theme = parsed.namespace;
const defaultLight = parsed.defaultLight;
const defaultDark = parsed.defaultDark;
const themes = parsed.themes;
const colorTokens = colorRoleNames(defaultLight);
const roles = THEME_ROLES as readonly string[];

/**
 * The contract's role list and the stylesheet are two copies of one fact. They are compared *in
 * order*, not as sets: a new role has to be appended deliberately on both sides, and the order is
 * what keeps generated constructors, the editor and the custom-theme validator talking about the same
 * palette.
 */
function assertRoleContract(): void {
  const fromCss = colorTokens.map((name) => name.replace(/^--/, ''));
  const mismatch = fromCss.length !== roles.length || fromCss.some((name, index) => name !== roles[index]);
  if (!mismatch) return;
  const missing = roles.filter((name) => !fromCss.includes(name));
  const extra = fromCss.filter((name) => !roles.includes(name));
  throw new Error(
    `The stylesheet's ${fromCss.length} colour roles and contracts' ${roles.length} THEME_ROLES disagree`
    + `${missing.length ? `; missing in CSS: ${missing.join(', ')}` : ''}`
    + `${extra.length ? `; absent from THEME_ROLES: ${extra.join(', ')}` : ''}`,
  );
}

/** Every built-in theme needs exactly sixteen ANSI colours per half, or a client has a partial table. */
function assertAnsi(): void {
  for (const entry of themes) {
    const ansi = BUILTIN_ANSI[entry.id];
    if (!ansi) throw new Error(`Theme "${entry.id}" has no ANSI table in scripts/theme-ansi.ts`);
    for (const mode of ['light', 'dark'] as const) {
      const colors = ansi[mode];
      if (colors.length !== THEME_ANSI_KEYS.length) {
        throw new Error(`Theme "${entry.id}" ${mode} ANSI has ${colors.length} colours, expected ${THEME_ANSI_KEYS.length}`);
      }
      colors.forEach((value, index) => {
        if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Theme "${entry.id}" ${mode} ANSI slot ${index} is not #rrggbb: ${value}`);
      });
    }
  }
  const unknown = Object.keys(BUILTIN_ANSI).filter((id) => !themes.some((entry) => entry.id === id));
  if (unknown.length) throw new Error(`scripts/theme-ansi.ts names themes the stylesheet does not define: ${unknown.join(', ')}`);
}

function assertCodeThemes(): void {
  const seen = new Set<string>();
  for (const entry of BUILTIN_CODE_THEMES) {
    if (seen.has(entry.id)) throw new Error(`Duplicate code theme id in scripts/code-themes.ts: ${entry.id}`);
    seen.add(entry.id);
    for (const mode of ['light', 'dark'] as const) {
      const half = entry[mode];
      for (const role of CODE_THEME_ROLES) {
        const value = half.colors[role];
        if (!/^#[0-9a-f]{6}$/i.test(value)) {
          throw new Error(`Code theme "${entry.id}" ${mode} role "${role}" is not #rrggbb: ${value}`);
        }
      }
    }
  }
  for (const id of BUILTIN_CODE_THEME_IDS) {
    if (!seen.has(id)) throw new Error(`BUILTIN_CODE_THEME_IDS names "${id}" which scripts/code-themes.ts does not define`);
  }
  for (const id of seen) {
    if (!(BUILTIN_CODE_THEME_IDS as readonly string[]).includes(id)) {
      throw new Error(`scripts/code-themes.ts defines "${id}" which is missing from BUILTIN_CODE_THEME_IDS`);
    }
  }
}

assertRoleContract();
assertAnsi();
assertCodeThemes();

const paletteIds = new Set(themes.map(theme => theme.id));
const catalogueIds = new Set<string>(WEB_BUILTIN_THEMES.map(theme => theme.id));
if (paletteIds.size !== WEB_BUILTIN_THEMES.length || catalogueIds.size !== paletteIds.size || [...catalogueIds].some(id => !paletteIds.has(id))) {
  throw new Error('WEB_BUILTIN_THEMES must name every built-in Web palette exactly once');
}

/**
 * Refuses to emit a half-defined theme. Compose's `RiffetColors` has one constructor per theme, so a
 * missing role would not fail until Kotlin compiled — and an *extra* role would silently be dropped
 * from the mobile palette while the web kept painting it. Both are caught here instead.
 */
function assertRoles(label: string, palette: Map<string, string>): void {
  const missing = colorTokens.filter((name) => !palette.has(name));
  const extra = [...palette.keys()].filter((name) => !NOT_A_COLOR_ROLE.test(name) && !colorTokens.includes(name));
  if (missing.length === 0 && extra.length === 0) return;
  const problems = [
    missing.length ? `missing ${missing.length}: ${missing.slice(0, 8).join(', ')}` : '',
    extra.length ? `unexpected ${extra.length}: ${extra.slice(0, 8).join(', ')}` : '',
  ].filter(Boolean).join('; ');
  throw new Error(`${label} does not match the ${colorTokens.length}-role palette: ${problems}`);
}

for (const entry of themes) {
  assertRoles(`theme "${entry.id}" light`, entry.light);
  assertRoles(`theme "${entry.id}" dark`, entry.dark);
}

const contrastFailures = themeContrastFailures(themes);
if (contrastFailures.length) {
  throw new Error(`Built-in themes break the contrast rules of docs/THEMES.md 2.2:\n  ${contrastFailures.join('\n  ')}`);
}


const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/i;

/** Emits `Color(0xAARRGGBB)`; both the Int and Long Compose overloads read the low 32 bits as ARGB. */
function color(value: string, token: string): string {
  const hex = HEX.exec(value);
  if (hex) {
    const digits = hex[1]!.length <= 4
      ? hex[1]!.split('').map((character) => character + character).join('')
      : hex[1]!;
    const argb = digits.length === 6 ? `ff${digits}` : `${digits.slice(6)}${digits.slice(0, 6)}`;
    return `Color(0x${argb.toUpperCase()})`;
  }
  const rgb = RGB.exec(value);
  if (rgb) {
    const alpha = Math.round(Number(rgb[4]) * 255);
    const channel = (raw: string) => Number(raw).toString(16).padStart(2, '0');
    const argb = `${channel(String(alpha))}${channel(rgb[1]!)}${channel(rgb[2]!)}${channel(rgb[3]!)}`;
    return `Color(0x${argb.toUpperCase()})`;
  }
  throw new Error(`Token ${token} has a colour form this generator cannot express: ${value}`);
}

// Colour roles and shadows are derived above, from the default theme's two blocks.
const textSizes = [...theme.keys()].filter((name) => /^--text-[a-z0-9-]+$/.test(name) && !name.includes('--line-height'));
const radii = [...theme.keys()].filter((name) => name.startsWith('--radius-'));
const fonts = [...theme.keys()].filter((name) => name.startsWith('--font-'));

const lines: string[] = [];
const write = (line = '') => lines.push(line);

write('// Generated by scripts/gen-mobile-theme.ts from apps/web/src/styles/index.css.');
write('// Do not edit by hand: change the stylesheet and re-run `pnpm gen:theme`.');
write(`package ${packageName}`);
write();
write('import androidx.compose.runtime.Immutable');
write('import androidx.compose.ui.graphics.Color');
write('import androidx.compose.ui.unit.Dp');
write('import androidx.compose.ui.unit.TextUnit');
write('import androidx.compose.ui.unit.dp');
write('import androidx.compose.ui.unit.sp');
write();
write('/** One colour role per CSS custom property in the web palette. */');
write('@Immutable');
write('data class RiffetColors(');
for (const name of colorTokens) write(`    val ${identifier(camel(name))}: Color,`);
write(')');
write();
for (const entry of themes) {
  const prefix = camel(`--${entry.id}`);
  for (const [suffix, palette] of [['Light', entry.light], ['Dark', entry.dark]] as const) {
    write(`val ${prefix}${suffix} = RiffetColors(`);
    for (const name of colorTokens) write(`    ${identifier(camel(name))} = ${color(palette.get(name)!, `${entry.id}/${name}`)},`);
    write(')');
    write();
  }
}
write('/** The sixteen ANSI terminal slots, in SGR 30–37 / 90–97 order. */');
write('@Immutable');
write('data class RiffetAnsi(val colors: List<Color>)');
write();
for (const entry of themes) {
  const prefix = camel(`--${entry.id}`);
  for (const [suffix, mode] of [['Light', 'light'], ['Dark', 'dark']] as const) {
    const colors = BUILTIN_ANSI[entry.id]![mode];
    write(`val ${prefix}${suffix}Ansi = RiffetAnsi(listOf(`);
    for (let index = 0; index < colors.length; index += 4) {
      write(`    ${colors.slice(index, index + 4).map((value) => color(value, `${entry.id}/${mode}/ansi-${index}`)).join(', ')},`);
    }
    write('))');
    write();
  }
}
write('/** A theme is a light and a dark palette that share one role set, plus the terminal ANSI slots. */');
write('@Immutable');
write('data class RiffetTheme(');
write('    val id: String,');
write('    val light: RiffetColors,');
write('    val dark: RiffetColors,');
write('    val ansiLight: RiffetAnsi,');
write('    val ansiDark: RiffetAnsi,');
write(')');
write();
write('/** Every built-in theme, in the order the pickers list them. */');
write('val RiffetThemes: List<RiffetTheme> = listOf(');
for (const entry of themes) {
  const prefix = camel(`--${entry.id}`);
  write(`    RiffetTheme(${JSON.stringify(entry.id)}, ${prefix}Light, ${prefix}Dark, ${prefix}LightAnsi, ${prefix}DarkAnsi),`);
}
write(')');
write();
write('/** The theme a device starts on, and the fallback for an id this build does not know. */');
write('val RiffetDefaultTheme: RiffetTheme = RiffetThemes.first()');
write();
write('fun riffetTheme(id: String?): RiffetTheme = RiffetThemes.firstOrNull { it.id == id } ?: RiffetDefaultTheme');
write();
write('/**');
write(' * Builds a palette from a custom theme\'s stored role values. Null when a role is missing or');
write(' * unreadable: a half-painted interface is worse than the default theme.');
write(' */');
write('fun riffetColors(roles: Map<String, String>): RiffetColors? {');
for (const name of colorTokens) {
  write(`    val ${camel(name)} = RiffetColorParsing.parse(roles[${JSON.stringify(name.replace(/^--/, ''))}]) ?: return null`);
}
write('    return RiffetColors(');
for (const name of colorTokens) write(`        ${camel(name)} = ${camel(name)},`);
write('    )');
write('}');
write();
write('/** Parses a custom theme\'s ANSI list; null unless it holds exactly sixteen readable colours. */');
write('fun riffetAnsi(colors: List<String>): RiffetAnsi? {');
write('    if (colors.size != 16) return null');
write('    return RiffetAnsi(colors.map { RiffetColorParsing.parse(it) ?: return null })');
write('}');
write();
write('/** Font stacks are shipped verbatim; a platform resolves them to its own families. */');
write('@Immutable');
write('data class RiffetFonts(');
for (const name of fonts) write(`    val ${identifier(camel(name))}: String,`);
write(')');
write();
write('val RiffetFontFamilies = RiffetFonts(');
for (const name of fonts) write(`    ${identifier(camel(name))} = ${JSON.stringify(theme.get(name)!.replace(/\s+/g, ' ').trim())},`);
write(')');
write();
write('/** A size and the line height the web pairs with it, kept together so they cannot drift apart. */');
write('@Immutable');
write('data class RiffetTextStyle(val size: TextUnit, val lineHeight: TextUnit)');
write();
write('object RiffetText {');
for (const name of textSizes) {
  const role = identifier(camel(name.replace(/^--text-/, '')));
  const lineHeight = theme.get(`${name}--line-height`) ?? theme.get(name)!;
  write(`    val ${role} = RiffetTextStyle(${length(theme.get(name)!, 'sp')}, ${length(lineHeight, 'sp')})`);
}
write('}');
write();
emitProse();
write('@Immutable');
write('data class RiffetRadii(');
for (const name of radii) write(`    val ${identifier(camel(name.replace(/^--radius-/, '')))}: Dp,`);
write(')');
write();
write('val RiffetRadius = RiffetRadii(');
for (const name of radii) write(`    ${identifier(camel(name.replace(/^--radius-/, '')))} = ${length(theme.get(name)!, 'dp')},`);
write(')');
write();
write('/** The web easing curve closest to what the UI uses for structural motion. */');
if (theme.has('--ease-out-soft')) write(`const val RIFFET_EASE_OUT_SOFT = ${JSON.stringify(theme.get('--ease-out-soft')!)}`);
write();

write('/** Code syntax highlighting roles (docs/design/system/foundations.md §1.1). */');
write('@Immutable');
write('data class RiffetCodeColors(');
for (const role of CODE_THEME_ROLES) write(`    val ${role}: Color,`);
write('    val commentItalic: Boolean = true,');
write(')');
write();
for (const entry of BUILTIN_CODE_THEMES) {
  const prefix = camel(`--code-${entry.id}`);
  for (const [suffix, half] of [['Light', entry.light], ['Dark', entry.dark]] as const) {
    write(`val ${prefix}${suffix} = RiffetCodeColors(`);
    for (const role of CODE_THEME_ROLES) write(`    ${role} = ${color(half.colors[role], `code/${entry.id}/${role}`)},`);
    write(`    commentItalic = ${half.commentItalic ?? true},`);
    write(')');
    write();
  }
}
write('@Immutable');
write('data class RiffetCodeTheme(');
write('    val id: String,');
write('    val name: String,');
write('    val light: RiffetCodeColors,');
write('    val dark: RiffetCodeColors,');
write(')');
write();
write('val RiffetCodeThemes: List<RiffetCodeTheme> = listOf(');
for (const entry of BUILTIN_CODE_THEMES) {
  const prefix = camel(`--code-${entry.id}`);
  write(`    RiffetCodeTheme(${JSON.stringify(entry.id)}, ${JSON.stringify(entry.name)}, ${prefix}Light, ${prefix}Dark),`);
}
write(')');
write();
write(`val RiffetDefaultCodeTheme: RiffetCodeTheme = RiffetCodeThemes.first { it.id == ${JSON.stringify(DEFAULT_CODE_THEME_ID)} }`);
write();
write('private val UI_THEME_DEFAULT_CODE_THEME: Map<String, String> = mapOf(');
for (const [uiId, codeId] of Object.entries(UI_THEME_DEFAULT_CODE_THEME)) {
  write(`    ${JSON.stringify(uiId)} to ${JSON.stringify(codeId)},`);
}
write(')');
write();
write('fun resolveCodeThemeId(selection: String?, uiThemeId: String? = null): String {');
write('    if (selection != null && RiffetCodeThemes.any { it.id == selection }) return selection');
write(`    return uiThemeId?.let { UI_THEME_DEFAULT_CODE_THEME[it] } ?: ${JSON.stringify(DEFAULT_CODE_THEME_ID)}`);
write('}');
write();
write('fun riffetCodeTheme(selection: String?, uiThemeId: String? = null): RiffetCodeTheme {');
write('    val id = resolveCodeThemeId(selection, uiThemeId)');
write('    return RiffetCodeThemes.firstOrNull { it.id == id } ?: RiffetDefaultCodeTheme');
write('}');
write();
write('fun riffetCodeColors(roles: Map<String, String>, commentItalic: Boolean = true): RiffetCodeColors? {');
for (const role of CODE_THEME_ROLES) {
  write(`    val ${role} = RiffetColorParsing.parse(roles[${JSON.stringify(role)}]) ?: return null`);
}
write('    return RiffetCodeColors(');
for (const role of CODE_THEME_ROLES) write(`        ${role} = ${role},`);
write('        commentItalic = commentItalic,');
write('    )');
write('}');
write();

/**
 * The answer's reading surface (`.md`), as the web lays it out on a phone.
 *
 * Sizes are the `:root` type block's `calc(Npx * var(--text-scale))` tokens at scale 1, with the
 * touch layout's override (`html:root` in the narrow-screen query: 15px body, unitless 1.7 leading)
 * applied on top. Spacing is read from the `.md` rules themselves (`p` margin, `li` margin, heading
 * margins, …), so a change to the web's prose rhythm reaches the phone on the next `gen:theme`.
 */
function emitProse(): void {
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Innermost rules only: a body never contains a brace, so an at-rule's own block is skipped and
  // the selector is whatever follows the last `{`, `}` or `;` before the body.
  const rules: { selector: string; body: Map<string, string> }[] = [];
  for (const match of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.split(',').map((part) => part.trim().replace(/\s+/g, ' ')).join(', ');
    const body = new Map<string, string>();
    for (const part of match[2]!.split(';')) {
      const at = part.indexOf(':');
      if (at > 0) body.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    rules.push({ selector, body });
  }
  /** One declaration of the rule(s) with exactly [selector]; a later rule wins, as in CSS. */
  const declared = (selector: string, property: string): string => {
    let value: string | undefined;
    for (const rule of rules) if (rule.selector === selector && rule.body.has(property)) value = rule.body.get(property);
    if (value === undefined) throw new Error(`gen:theme: ${selector} { ${property} } not found in the stylesheet`);
    return value;
  };
  /** A `margin`/`padding` shorthand or longhand side, in px; `calc(<n>px * var(--text-scale))` is `<n>px`, which a scale of 1 means. */
  const side = (selector: string, property: 'margin' | 'padding', which: 'top' | 'right' | 'bottom' | 'left'): number => {
    const rule = [...rules].reverse().find((entry) => entry.selector === selector && (entry.body.has(`${property}-${which}`) || entry.body.has(property)));
    const longhand = rule?.body.get(`${property}-${which}`);
    if (longhand !== undefined) return scaled(longhand);
    const parts = declared(selector, property).match(/calc\((?:[^()]|\([^()]*\))*\)|\S+/g) ?? [];
    const [top, right = top, bottom = top, left = right] = parts;
    return scaled({ top, right, bottom, left }[which]!);
  };
  const pixels = (value: string): number => {
    if (value === '0') return 0;
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
    if (!match) throw new Error(`gen:theme: expected a px length, received ${value}`);
    return Number(match[1]);
  };
  const scaled = (value: string): number => {
    const match = /^calc\((\d+(?:\.\d+)?)px \* var\(--text-scale\)\)$/.exec(value.trim());
    return match ? Number(match[1]) : pixels(value);
  };
  const typeBlock = rules.find((rule) => rule.selector === ':root' && rule.body.has('--text-scale'))?.body;
  if (!typeBlock) throw new Error('gen:theme: the :root block with --text-scale was not found');
  const touch = rules.filter((rule) => rule.selector === 'html:root' && rule.body.has('--text-md')).at(-1)?.body ?? new Map<string, string>();
  const token = (name: string): string => {
    const value = touch.get(name) ?? typeBlock.get(name);
    if (value === undefined) throw new Error(`gen:theme: ${name} not found`);
    return value;
  };
  const size = (name: string) => scaled(token(name));
  const leading = (name: string, fontSize: number) => {
    const value = token(name).trim();
    return /^\d+(?:\.\d+)?$/.test(value) ? Math.round(Number(value) * fontSize * 100) / 100 : scaled(value);
  };
  const body = size('--text-md');
  const unit = (value: number, kind: 'sp' | 'dp') => `${value}.${kind}`;
  const style = (fontSize: number, lineHeight: number) => `RiffetTextStyle(${unit(fontSize, 'sp')}, ${unit(lineHeight, 'sp')})`;
  const heading = '.md h1, .md h2, .md h3, .md h4, .md h5, .md h6';
  const list = '.md ul, .md ol';
  write('/**');
  write(' * The answer\'s reading surface (`.md`) on a phone: the web\'s touch-layout type and the `.md`');
  write(' * rules\' spacing, at text scale 1. Spacing is CSS-box spacing: lines carry their half-leading on');
  write(' * both sides, as a browser lays them out.');
  write(' */');
  write('object RiffetProse {');
  write(`    val body = ${style(body, leading('--leading-md', body))}`);
  write(`    val h1 = ${style(size('--text-h1'), leading('--leading-h1', size('--text-h1')))}`);
  write(`    val h2 = ${style(size('--text-h2'), leading('--leading-h2', size('--text-h2')))}`);
  write(`    val h3 = ${style(size('--text-h3'), leading('--leading-h3', size('--text-h3')))}`);
  write(`    val h4 = ${style(body, leading('--leading-h4', body))}`);
  write(`    val code = ${style(size('--text-code'), leading('--leading-code', size('--text-code')))}`);
  write(`    val table = ${style(size('--text-sm'), leading('--text-sm--line-height', size('--text-sm')))}`);
  write(`    val paragraphGap = ${unit(side('.md p', 'margin', 'bottom'), 'dp')}`);
  write(`    val itemGap = ${unit(side('.md li', 'margin', 'top'), 'dp')}`);
  write(`    val itemBlockGap = ${unit(side('.md li > p + p', 'margin', 'top'), 'dp')}`);
  write(`    val nestedListGap = ${unit(side('.md li > ul, .md li > ol', 'margin', 'top'), 'dp')}`);
  write(`    val listIndent = ${unit(side(list, 'padding', 'left'), 'dp')}`);
  write(`    val listGap = ${unit(side(list, 'margin', 'bottom'), 'dp')}`);
  write(`    val headingTop = ${unit(side(heading, 'margin', 'top'), 'dp')}`);
  write(`    val headingBottom = ${unit(side(heading, 'margin', 'bottom'), 'dp')}`);
  write(`    val quoteInset = ${unit(side('.md blockquote', 'padding', 'left'), 'dp')}`);
  write(`    val ruleGap = ${unit(side('.md hr', 'margin', 'top'), 'dp')}`);
  write(`    val tableGap = ${unit(side('.md table', 'margin', 'bottom'), 'dp')}`);
  write(`    val tableCellVertical = ${unit(side('.md th, .md td', 'padding', 'top'), 'dp')}`);
  write(`    val tableCellHorizontal = ${unit(side('.md th, .md td', 'padding', 'left'), 'dp')}`);
  write('}');
  write();
}

/** A `px` token becomes a Compose length. Font sizes are `sp`; everything else is `dp`. */
function length(value: string, unit: 'dp' | 'sp'): string {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match) throw new Error(`Expected a px length, received: ${value}`);
  return `${match[1]}.${unit}`;
}

/** The same palette for the macOS app: RGBA values, wrapped in appearance-aware colours by `Theme.swift`. */
function swiftRgba(value: string, token: string): string {
  const argb = /0x([0-9A-F]{8})/.exec(color(value, token))![1]!;
  const channel = (offset: number) => (parseInt(argb.slice(offset, offset + 2), 16) / 255).toFixed(4);
  return `RiffetRGBA(${channel(2)}, ${channel(4)}, ${channel(6)}, ${channel(0)})`;
}

const swift: string[] = [];
const emit = (line = '') => swift.push(line);
emit('// Generated by scripts/gen-mobile-theme.ts from apps/web/src/styles/index.css.');
emit('// Do not edit by hand: change the stylesheet and re-run `pnpm gen:theme`.');
emit('import CoreGraphics');
emit();
emit('struct RiffetRGBA: Sendable {');
emit('    let red: Double, green: Double, blue: Double, alpha: Double');
emit('    init(_ red: Double, _ green: Double, _ blue: Double, _ alpha: Double) {');
emit('        self.red = red; self.green = green; self.blue = blue; self.alpha = alpha');
emit('    }');
emit('}');
emit();
emit('/** One colour role per CSS custom property in the web palette. */');
emit('struct RiffetPaletteValues: Sendable {');
for (const name of colorTokens) emit(`    let ${camel(name)}: RiffetRGBA`);
emit();
emit('    init(');
for (const name of colorTokens) emit(`        ${camel(name)}: RiffetRGBA${name === colorTokens.at(-1) ? '' : ','}`);
emit('    ) {');
for (const name of colorTokens) emit(`        self.${camel(name)} = ${camel(name)}`);
emit('    }');
emit();
emit('    /**');
emit('     * Builds a palette from a custom theme\'s stored role values. Nil when any role is missing or');
emit('     * unreadable: a half-painted interface is worse than the default theme.');
emit('     */');
emit('    init?(roleValues: [String: String]) {');
emit('        guard');
for (const name of colorTokens) {
  const role = name.replace(/^--/, '');
  emit(`            let ${camel(name)} = RiffetRGBA(hex: roleValues[${JSON.stringify(role)}])${name === colorTokens.at(-1) ? '' : ','}`);
}
emit('        else { return nil }');
emit('        self.init(');
for (const name of colorTokens) emit(`            ${camel(name)}: ${camel(name)}${name === colorTokens.at(-1) ? '' : ','}`);
emit('        )');
emit('    }');
emit();
emit('    /** The palette as role → `#rrggbb` / `#rrggbbaa`, for the theme editor. */');
emit('    func roleValues() -> [String: String] {');
emit('        [');
for (const name of colorTokens) {
  const role = name.replace(/^--/, '');
  emit(`            ${JSON.stringify(role)}: ${camel(name)}.hex${name === colorTokens.at(-1) ? '' : ','}`);
}
emit('        ]');
emit('    }');
emit('}');
emit();
emit('/** The sixteen ANSI terminal slots, in SGR 30–37 / 90–97 order. */');
emit('struct RiffetAnsiValues: Sendable {');
emit('    let light: [RiffetRGBA]');
emit('    let dark: [RiffetRGBA]');
emit();
emit('    init(light: [RiffetRGBA], dark: [RiffetRGBA]) {');
emit('        self.light = light');
emit('        self.dark = dark');
emit('    }');
emit();
emit('    /** Parses a custom theme\'s stored ANSI colours; nil unless each half has sixteen readable values. */');
emit('    init?(light: [String], dark: [String]) {');
emit('        guard light.count == 16, dark.count == 16,');
emit('              let light = RiffetAnsiValues.parse(light),');
emit('              let dark = RiffetAnsiValues.parse(dark)');
emit('        else { return nil }');
emit('        self.init(light: light, dark: dark)');
emit('    }');
emit();
emit('    private static func parse(_ values: [String]) -> [RiffetRGBA]? {');
emit('        var colors: [RiffetRGBA] = []');
emit('        colors.reserveCapacity(values.count)');
emit('        for value in values {');
emit('            guard let color = RiffetRGBA(hex: value) else { return nil }');
emit('            colors.append(color)');
emit('        }');
emit('        return colors');
emit('    }');
emit('}');
emit();
emit('struct RiffetThemeValues: Sendable {');
emit('    let id: String');
emit('    let light: RiffetPaletteValues');
emit('    let dark: RiffetPaletteValues');
emit('    let ansi: RiffetAnsiValues');
emit('}');
emit();
emit('enum RiffetThemeCatalog {');
for (const entry of themes) {
  const prefix = camel(`--${entry.id}`);
  for (const [suffix, palette] of [['Light', entry.light], ['Dark', entry.dark]] as const) {
    emit(`    static let ${prefix}${suffix} = RiffetPaletteValues(`);
    colorTokens.forEach((name, index) => emit(`        ${camel(name)}: ${swiftRgba(palette.get(name)!, `${entry.id}/${name}`)}${index === colorTokens.length - 1 ? '' : ','}`));
    emit('    )');
  }
  emit(`    static let ${prefix}Ansi = RiffetAnsiValues(`);
  for (const mode of ['light', 'dark'] as const) {
    const colors = BUILTIN_ANSI[entry.id]![mode];
    emit(`        ${mode}: [`);
    for (let index = 0; index < colors.length; index += 4) {
      const line = colors.slice(index, index + 4).map((value) => swiftRgba(value, `${entry.id}/${mode}/ansi-${index}`)).join(', ');
      emit(`            ${line}${index + 4 < colors.length ? ',' : ''}`);
    }
    emit('        ],');
  }
  emit('    )');
}
emit();
emit('    /** Every built-in theme, in the order the pickers list them. */');
emit('    static let all: [RiffetThemeValues] = [');
for (const entry of themes) {
  const prefix = camel(`--${entry.id}`);
  emit(`        RiffetThemeValues(id: ${JSON.stringify(entry.id)}, light: ${prefix}Light, dark: ${prefix}Dark, ansi: ${prefix}Ansi),`);
}
emit('    ]');
emit('}');
emit();
emit('/** Text sizes and the line heights the web pairs with them, in points. */');
emit('enum RiffetTextSize {');
for (const name of textSizes) {
  const role = camel(name.replace(/^--text-/, '')).replace(/^(\d)/, 'x$1');
  const lineHeight = theme.get(`${name}--line-height`) ?? theme.get(name)!;
  emit(`    static let ${role}: (size: CGFloat, lineHeight: CGFloat) = (${px(theme.get(name)!)}, ${px(lineHeight)})`);
}
emit('}');
emit();
emit('enum RiffetRadiusValue {');
for (const name of radii) emit(`    static let ${camel(name.replace(/^--radius-/, '')).replace(/^(\d)/, 'x$1')}: CGFloat = ${px(theme.get(name)!)}`);
emit('}');
emit('');
emit('/** Code syntax highlighting roles (docs/design/system/foundations.md §1.1). */');
emit('struct RiffetCodePaletteValues: Sendable {');
for (const role of CODE_THEME_ROLES) emit(`    let ${role}: RiffetRGBA`);
emit('    let commentItalic: Bool');
emit();
emit('    init(');
for (const role of CODE_THEME_ROLES) emit(`        ${role}: RiffetRGBA,`);
emit('        commentItalic: Bool = true');
emit('    ) {');
for (const role of CODE_THEME_ROLES) emit(`        self.${role} = ${role}`);
emit('        self.commentItalic = commentItalic');
emit('    }');
emit();
emit('    init?(roleValues: [String: String], commentItalic: Bool = true) {');
emit('        guard');
for (const role of CODE_THEME_ROLES) {
  emit(`            let ${role} = RiffetRGBA(hex: roleValues[${JSON.stringify(role)}])${role === CODE_THEME_ROLES.at(-1) ? '' : ','}`);
}
emit('        else { return nil }');
emit('        self.init(');
for (const role of CODE_THEME_ROLES) emit(`            ${role}: ${role},`);
emit('            commentItalic: commentItalic');
emit('        )');
emit('    }');
emit();
emit('    func roleValues() -> [String: String] {');
emit('        [');
for (const role of CODE_THEME_ROLES) {
  emit(`            ${JSON.stringify(role)}: ${role}.hex${role === CODE_THEME_ROLES.at(-1) ? '' : ','}`);
}
emit('        ]');
emit('    }');
emit('}');
emit();
emit('struct RiffetCodeThemeValues: Sendable {');
emit('    let id: String');
emit('    let name: String');
emit('    let light: RiffetCodePaletteValues');
emit('    let dark: RiffetCodePaletteValues');
emit('}');
emit();
emit('enum RiffetCodeThemeCatalog {');
for (const entry of BUILTIN_CODE_THEMES) {
  const prefix = camel(`--${entry.id}`);
  for (const [suffix, half] of [['Light', entry.light], ['Dark', entry.dark]] as const) {
    emit(`    static let ${prefix}${suffix} = RiffetCodePaletteValues(`);
    for (const role of CODE_THEME_ROLES) emit(`        ${role}: ${swiftRgba(half.colors[role], `code/${entry.id}/${role}`)},`);
    emit(`        commentItalic: ${half.commentItalic ?? true}`);
    emit('    )');
  }
}
emit();
emit('    static let all: [RiffetCodeThemeValues] = [');
for (const entry of BUILTIN_CODE_THEMES) {
  const prefix = camel(`--${entry.id}`);
  emit(`        RiffetCodeThemeValues(id: ${JSON.stringify(entry.id)}, name: ${JSON.stringify(entry.name)}, light: ${prefix}Light, dark: ${prefix}Dark),`);
}
emit('    ]');
emit();
emit('    static let uiThemeDefaults: [String: String] = [');
for (const [uiId, codeId] of Object.entries(UI_THEME_DEFAULT_CODE_THEME)) {
  emit(`        ${JSON.stringify(uiId)}: ${JSON.stringify(codeId)},`);
}
emit('    ]');
emit();
emit('    static func resolveId(selection: String?, uiThemeId: String? = nil) -> String {');
emit('        if let selection, all.contains(where: { $0.id == selection }) { return selection }');
emit(`        if let uiThemeId, let mapped = uiThemeDefaults[uiThemeId] { return mapped }`);
emit(`        return ${JSON.stringify(DEFAULT_CODE_THEME_ID)}`);
emit('    }');
emit();
emit('    static func resolve(selection: String?, uiThemeId: String? = nil) -> RiffetCodeThemeValues {');
emit('        let id = resolveId(selection: selection, uiThemeId: uiThemeId)');
emit('        return all.first(where: { $0.id == id }) ?? all[0]');
emit('    }');
emit('}');
emit('');

function px(value: string): string {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match) throw new Error(`Expected a px length, received: ${value}`);
  return match[1]!;
}

/**
 * The web's own copy of the built-in ANSI table. The browser cannot import this script, and the
 * terminal needs the slots synchronously, so the same source is emitted as a module.
 */
const webAnsi: string[] = [];
const emitWeb = (line = '') => webAnsi.push(line);
emitWeb('// Generated by scripts/gen-mobile-theme.ts from scripts/theme-ansi.ts.');
emitWeb('// Do not edit by hand: change the ANSI table and re-run `pnpm gen:theme`.');
emitWeb("import type { ThemeAnsi } from '@contracts';");
emitWeb();
emitWeb('/** The sixteen ANSI slots of every built-in theme, in SGR 30–37 / 90–97 order. */');
emitWeb('export const ANSI_BY_THEME: Record<string, ThemeAnsi> = {');
for (const entry of themes) {
  emitWeb(`  ${JSON.stringify(entry.id)}: {`);
  for (const mode of ['light', 'dark'] as const) {
    const colors = BUILTIN_ANSI[entry.id]![mode];
    emitWeb(`    ${mode}: [`);
    for (let index = 0; index < colors.length; index += 4) {
      const line = colors.slice(index, index + 4).map((value) => JSON.stringify(value)).join(', ');
      emitWeb(`      ${line},`);
    }
    emitWeb('    ],');
  }
  emitWeb('  },');
}
emitWeb('};');
emitWeb();

/**
 * The built-in palettes as literal hex, for the theme editor's "copy this theme" action. Reading
 * them out of the live stylesheet with `getComputedStyle` would depend on the sheet having loaded
 * and on some element matching the selector — a silent failure mode. These values are parsed from
 * the same source the generator already trusts.
 */
const webBuiltins: string[] = [];
const emitBuiltin = (line = '') => webBuiltins.push(line);
emitBuiltin('// Generated by scripts/gen-mobile-theme.ts from apps/web/src/styles/index.css.');
emitBuiltin('// Do not edit by hand: change the stylesheet and re-run `pnpm gen:theme`.');
emitBuiltin("import type { ThemeRole } from './theme.js';");
emitBuiltin();
emitBuiltin('export interface BuiltinThemePalette {');
emitBuiltin('  readonly light: Record<ThemeRole, string>;');
emitBuiltin('  readonly dark: Record<ThemeRole, string>;');
emitBuiltin('}');
emitBuiltin();
emitBuiltin('/** Every built-in theme as stored hex, in stylesheet order. */');
emitBuiltin('export const BUILTIN_THEME_PALETTES: Record<string, BuiltinThemePalette> = {');
for (const entry of themes) {
  emitBuiltin(`  ${JSON.stringify(entry.id)}: {`);
  for (const mode of ['light', 'dark'] as const) {
    const palette = mode === 'light' ? entry.light : entry.dark;
    emitBuiltin(`    ${mode}: {`);
    for (const name of colorTokens) {
      const value = palette.get(name)!;
      const parsed = parseColor(value);
      if (!parsed) throw new Error(`Theme ${entry.id}/${mode} role ${name} is not a colour: ${value}`);
      emitBuiltin(`      ${JSON.stringify(name.replace(/^--/, ''))}: ${JSON.stringify(colorToHex(parsed))},`);
    }
    emitBuiltin('    },');
  }
  emitBuiltin('  },');
}
emitBuiltin('};');
emitBuiltin('');

const webCodeThemes: string[] = [];
const emitCodeTheme = (line = '') => webCodeThemes.push(line);
emitCodeTheme('// Generated by scripts/gen-mobile-theme.ts from scripts/code-themes.ts.');
emitCodeTheme('// Do not edit by hand: change scripts/code-themes.ts and re-run `pnpm gen:theme`.');
emitCodeTheme("import type { BuiltinCodeTheme, BuiltinCodeThemeId } from '@contracts';");
emitCodeTheme();
emitCodeTheme('/** Every built-in code syntax theme in picker order. */');
emitCodeTheme('export const BUILTIN_CODE_THEMES: readonly BuiltinCodeTheme[] = [');
for (const entry of BUILTIN_CODE_THEMES) {
  emitCodeTheme('  {');
  emitCodeTheme(`    id: ${JSON.stringify(entry.id)},`);
  emitCodeTheme(`    name: ${JSON.stringify(entry.name)},`);
  if (entry.credit) emitCodeTheme(`    credit: ${JSON.stringify(entry.credit)},`);
  for (const mode of ['light', 'dark'] as const) {
    const half = entry[mode];
    emitCodeTheme(`    ${mode}: {`);
    emitCodeTheme(`      commentItalic: ${half.commentItalic ?? true},`);
    emitCodeTheme('      colors: {');
    for (const role of CODE_THEME_ROLES) {
      emitCodeTheme(`        ${role}: ${JSON.stringify(half.colors[role].toLowerCase())},`);
    }
    emitCodeTheme('      },');
    emitCodeTheme('    },');
  }
  emitCodeTheme('  },');
}
emitCodeTheme('];');
emitCodeTheme();
emitCodeTheme('export function codeThemeDefinition(id: BuiltinCodeThemeId): BuiltinCodeTheme {');
emitCodeTheme('  return BUILTIN_CODE_THEMES.find((entry) => entry.id === id) ?? BUILTIN_CODE_THEMES[0]!;');
emitCodeTheme('}');
emitCodeTheme();

function emitCssCodeThemes(): string {
  const raw = readFileSync(cssPath, 'utf8');
  const begin = '/* BEGIN GENERATED code-themes (scripts/gen-mobile-theme.ts) */';
  const end = '/* END GENERATED code-themes */';
  const start = raw.indexOf(begin);
  const stop = raw.indexOf(end);
  if (start < 0 || stop < start) throw new Error('gen:theme: markers for code-themes missing in apps/web/src/styles/index.css');
  const cssLines: string[] = [begin];
  const emitDecls = (half: (typeof BUILTIN_CODE_THEMES)[number]['light'], dark: boolean, includeBase: boolean) => {
    if (includeBase) {
      cssLines.push('  --code-fg: var(--fg);');
      cssLines.push('  --code-link: var(--accent);');
    }
    cssLines.push(`  --code-comment-style: ${(half.commentItalic ?? true) ? 'italic' : 'normal'};`);
    const fgMix = dark ? 90 : 88;
    const commentMix = dark ? 85 : 80;
    for (const role of CODE_THEME_ROLES) {
      const hex = half.colors[role].toLowerCase();
      const target = role === 'comment' ? `color-mix(in oklab, ${hex} ${commentMix}%, var(--fg-3))` : `color-mix(in oklab, ${hex} ${fgMix}%, var(--fg))`;
      cssLines.push(`  --code-${role}: ${target};`);
    }
  };
  for (const entry of BUILTIN_CODE_THEMES) {
    const isDefault = entry.id === DEFAULT_CODE_THEME_ID;
    cssLines.push(isDefault ? `:root,\n[data-code-theme=${JSON.stringify(entry.id)}]:not(.dark) {` : `[data-code-theme=${JSON.stringify(entry.id)}]:not(.dark) {`);
    emitDecls(entry.light, false, isDefault);
    cssLines.push('}');
    cssLines.push(isDefault ? `.dark,\n[data-code-theme=${JSON.stringify(entry.id)}].dark {` : `[data-code-theme=${JSON.stringify(entry.id)}].dark {`);
    emitDecls(entry.dark, true, false);
    cssLines.push('}');
  }
  cssLines.push(end);
  return raw.slice(0, start) + cssLines.join('\n') + raw.slice(stop + end.length);
}

const swiftOut = resolve(root, 'apps/macos/Riffet/Theme/RiffetTheme.swift');
// The iOS app consumes the identical Swift palette; only the handwritten wrapper differs.
const iosSwiftOut = resolve(root, 'apps/mobile/iosApp/Riffet/Theme/RiffetTheme.swift');
const webAnsiOut = resolve(root, 'apps/web/src/lib/theme-ansi.generated.ts');
const webBuiltinsOut = resolve(root, 'packages/contracts/src/theme-builtins.generated.ts');
const webCodeThemesOut = resolve(root, 'apps/web/src/lib/code-themes.generated.ts');
const outputs: [string, string][] = [
  [cssPath, emitCssCodeThemes()],
  [outPath, lines.join('\n')],
  [swiftOut, swift.join('\n')],
  [iosSwiftOut, swift.join('\n')],
  [webAnsiOut, webAnsi.join('\n')],
  [webBuiltinsOut, webBuiltins.join('\n')],
  [webCodeThemesOut, webCodeThemes.join('\n')],
];
let stale = false;
for (const [path, generated] of outputs) {
  if (checkOnly) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* reported as stale below */ }
    if (current !== generated) {
      console.error(`gen:theme: ${path} is stale. Run \`pnpm gen:theme\` and commit the result.`);
      stale = true;
    } else {
      console.log(`gen:theme: ${path} is up to date.`);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated);
    console.log(`gen:theme: wrote ${path} (${colorTokens.length} colours, ${textSizes.length} text sizes, ${radii.length} radii)`);
  }
}
if (stale) process.exit(1);
