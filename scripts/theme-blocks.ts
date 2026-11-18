import { DEFAULT_WEB_THEME_ID } from '../packages/contracts/src/theme.js';

/**
 * The stylesheet's theme-block grammar, in one place.
 *
 * `scripts/gen-mobile-theme.ts` and the stylesheet's own tests both need to answer "what themes
 * exist, and what does each one define". Keeping two parsers would let the generator and the
 * contrast gate disagree about a palette — the exact class of drift the generator exists to prevent
 * — so both import this module.
 *
 * The grammar:
 *
 *   :root                                  default theme, light
 *   .dark                                  default theme, dark
 *   [data-theme="<id>"]:not(.dark)         theme <id>, light
 *   [data-theme="<id>"].dark               theme <id>, dark
 *   @theme                                 scales (fonts, text, radii) — not a palette
 *
 * The two attribute selectors carry equal specificity and outrank a bare `.dark`, which is what
 * lets a themed page keep using the protocol's plain `dark:` utilities: the class still means
 * "dark mode", and the attribute means "which palette".
 */

/** The id the `:root` / `.dark` pair is registered under. */
export const DEFAULT_THEME_ID = DEFAULT_WEB_THEME_ID;

/**
 * Tokens that are not colour roles. `--shadow-*` is mode-dependent rather than palette-dependent —
 * `.dark` still matches on a themed page, so shadows follow the mode without every theme restating
 * them — and the rest are scales the generator emits separately.
 */
export const NOT_A_COLOR_ROLE = /^--(shadow|ease|duration|text|radius|font|timeline|content-width)/;

export interface ThemePalette {
  id: string;
  light: Map<string, string>;
  dark: Map<string, string>;
}

export interface ParsedStylesheet {
  defaultLight: Map<string, string>;
  defaultDark: Map<string, string>;
  /** The `@theme` block: fonts, text sizes, radii. */
  namespace: Map<string, string>;
  /** The default theme first, then every `[data-theme]` pair in source order. */
  themes: ThemePalette[];
}

/**
 * The three parsers below are private to this module: `parseStylesheet` is the only entry point
 * anything outside needs, and an unexported helper cannot be depended on by accident.
 */

/** Comments are removed first: a `/* … *\/` between two declarations must not be read as one. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The declarations of the block whose selector starts a line, so a mention of `.dark` inside another
 * at-rule is not mistaken for the block itself.
 *
 * The selector may be the first item of a list — the default theme is written as
 * `:root, [data-theme="riffet"]:not(.dark)` so that an element can opt into Riffet's palette the
 * same way it opts into any other one, which is what a picker swatch does. Only the first item has
 * to match, and only the declarations are returned.
 */
function blockBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The list may wrap: `:root,` and its alias are on separate lines for readability.
  const match = new RegExp(`^[ \\t]*${escaped}[ \\t]*(?:,[ \\t]*(?:\\r?\\n[ \\t]*)?[^{,\\n]+)*[ \\t]*\\{`, 'm').exec(css);
  if (!match) throw new Error(`Selector ${selector} not found in the stylesheet`);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`Unbalanced braces after ${selector}`);
}

function declarations(body: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!name.startsWith('--') || !value) continue;
    result.set(name, value);
  }
  return result;
}

const THEME_BLOCK = /^[ \t]*\[data-theme="([a-z0-9-]+)"\](:not\(\.dark\)|\.dark)[ \t]*\{/gm;

/**
 * Reads every theme out of the stylesheet. The default pair is registered under
 * [DEFAULT_THEME_ID] so callers see one uniform list rather than a special case.
 */
export function parseStylesheet(rawCss: string): ParsedStylesheet {
  const css = stripComments(rawCss);
  const found = new Map<string, ThemePalette>();
  for (const match of css.matchAll(THEME_BLOCK)) {
    const id = match[1]!;
    const entry = found.get(id) ?? { id, light: new Map(), dark: new Map() };
    const selector = match[0].slice(0, match[0].lastIndexOf('{')).trim();
    if (match[2] === '.dark') entry.dark = declarations(blockBody(css, selector));
    else entry.light = declarations(blockBody(css, selector));
    found.set(id, entry);
  }
  const defaultLight = declarations(blockBody(css, ':root'));
  const defaultDark = declarations(blockBody(css, '.dark'));
  // The default theme is also written as `:root, [data-theme="riffet"]:not(.dark)` so an element can
  // opt into it exactly the way it opts into any other theme — a picker swatch needs that, or its
  // "light" tile would inherit the dark page around it. Those aliases are the same rules, so they
  // are dropped here instead of being registered as a second `riffet`.
  found.delete(DEFAULT_THEME_ID);
  return {
    defaultLight,
    defaultDark,
    namespace: declarations(blockBody(css, '@theme')),
    themes: [{ id: DEFAULT_THEME_ID, light: defaultLight, dark: defaultDark }, ...found.values()],
  };
}

/** The colour roles a palette is expected to define, read from the default theme's light block. */
export function colorRoleNames(defaultLight: Map<string, string>): string[] {
  return [...defaultLight.keys()].filter((name) => !NOT_A_COLOR_ROLE.test(name));
}

// The colour maths lives in the contract module so the generator, the editor and the stylesheet
// tests measure colours with one implementation. `perceptualDistance`'s doc comment stays there.
export {
  parseColor, composite, relativeLuminance, contrastRatio, perceptualDistance,
} from '../packages/contracts/src/theme.js';
export type { Rgba } from '../packages/contracts/src/theme.js';
