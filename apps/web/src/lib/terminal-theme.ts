import type { ITheme } from '@xterm/xterm';
import { colorToHex, composite, parseColor, type TerminalAppearance } from '@contracts';
import { ansiSlots, ansiSlotsFrom } from './terminal-ansi';

export const terminalFont = {
  fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "PingFang SC", monospace',
  fontSize: 12.5,
  lineHeight: 1.3,
};

/**
 * Resolve a user's chosen terminal font name into a concrete CSS font-family stack.
 *
 * - "JetBrains Mono" maps first to the bundled `@fontsource-variable/jetbrains-mono` face
 *   ("JetBrains Mono Variable") so weights 300–900 work even when the font is not installed locally.
 * - "SF Mono" uses CSS `ui-monospace` first because WebKit/Blink hide the literal "SF Mono" name
 *   from web pages for fingerprinting protection.
 */
export function resolveTerminalFontFamily(choice: string): string {
  const trimmed = choice.trim();
  if (!trimmed) return terminalFont.fontFamily;
  const lower = trimmed.toLowerCase();
  if (lower === 'jetbrains mono') {
    return '"JetBrains Mono Variable", "JetBrains Mono", "PingFang SC", monospace';
  }
  if (lower === 'sf mono') {
    return 'ui-monospace, "SF Mono", Menlo, "PingFang SC", monospace';
  }
  const hasMultiple = trimmed.includes(',');
  const quoted = !hasMultiple && /\s/.test(trimmed) && !trimmed.includes('"') && !trimmed.includes("'")
    ? `"${trimmed}"`
    : trimmed;
  return `${quoted}, "PingFang SC", monospace`;
}

/**
 * A terminal theme built from the palette that is actually on screen.
 *
 * The surface, ink, cursor and selection come from the same CSS custom properties every other
 * surface uses, read back from the root element — so picking Solarized moves the terminal with the
 * rest of the app instead of leaving a GitHub-coloured pane behind. Only the 16 ANSI slots are
 * curated (`scripts/theme-ansi.ts` explains why they are a separate contract).
 *
 * `ansi` is a custom theme's sixteen values. They cannot come from the generated table, because a
 * custom palette exists only in the shared library; the caller passes the half matching the mode.
 *
 * xterm resolves neither `var()` nor `color-mix()`, so the values have to arrive as concrete
 * colours. Normalize stylesheet tokens to opaque #rrggbb here: production CSS can shorten
 * #ffffff to #fff, and custom palettes can contain alpha. History's numeric colour calculations
 * and the live terminal must receive the same RGB values. Selection tint is applied afterward.
 */
export function terminalTheme(themeId: string, dark: boolean, ansi?: readonly string[]): ITheme {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  const token = (name: string, fallback: string, surface = fallback) => {
    const value = root ? getComputedStyle(root).getPropertyValue(name).trim() : '';
    const parsed = parseColor(value || fallback);
    return parsed ? colorToHex([...composite(parsed, parseColor(surface)!), 1]) : fallback;
  };
  const background = token('--bg', dark ? '#141416' : '#ffffff');
  const foreground = token('--fg', dark ? '#e6e8eb' : '#1f2328', background);
  const accent = token('--accent', dark ? '#5b8cff' : '#3867f0', background);
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: tint(accent, dark ? 0.3 : 0.18),
    ...(ansiSlotsFrom(ansi) ?? ansiSlots(themeId, dark)),
  };
}

/** Capture applied page colours at the request, including custom themes and CSS shorthand. */
export function pageTerminalAppearance(): TerminalAppearance {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const theme = terminalTheme('riffet', dark);
  return { foreground: theme.foreground!, background: theme.background! };
}

/** `#rrggbb` at an alpha, as the `rgba(...)` xterm accepts. Non-hex input falls back to the accent. */
function tint(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const digits = match[1]!;
  const channel = (at: number) => parseInt(digits.slice(at, at + 2), 16);
  return `rgba(${channel(0)},${channel(2)},${channel(4)},${alpha})`;
}

