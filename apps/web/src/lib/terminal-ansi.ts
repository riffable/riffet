import type { ITheme } from '@xterm/xterm';
import { THEME_ANSI_KEYS } from '@contracts';
import { ANSI_BY_THEME } from './theme-ansi.generated';

/**
 * The 16 ANSI slots, per built-in theme.
 *
 * ANSI is curated rather than derived from the design roles: the roles describe *this app's*
 * surfaces, while the ANSI slots are a contract with whatever program is running inside the
 * terminal — `git diff`, `ls`, a test runner — and they have to stay mutually distinguishable in a
 * way app colours are never asked to be. The values and their provenance live in
 * `scripts/theme-ansi.ts`; `theme-ansi.generated.ts` is emitted from it so web, Kotlin and Swift
 * cannot drift apart.
 *
 * Custom themes carry their own sixteen values and are merged in by `theme-library.ts`.
 */

/** Bytes → the `ITheme` xterm wants, with `foreground`/`background` supplied by the caller. */
type AnsiSlots = Pick<ITheme, 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'>;

export function ansiSlots(themeId: string, dark: boolean): AnsiSlots {
  const entry = ANSI_BY_THEME[themeId] ?? ANSI_BY_THEME.riffet;
  const colors = dark ? entry.dark : entry.light;
  return Object.fromEntries(THEME_ANSI_KEYS.map((key, index) => [key, colors[index]])) as AnsiSlots;
}

/**
 * A custom theme's sixteen values, in the same order as `THEME_ANSI_KEYS`. Returns undefined for a
 * list of the wrong length so a partial palette cannot silently put the wrong colour in a slot.
 */
export function ansiSlotsFrom(colors: readonly string[] | undefined): AnsiSlots | undefined {
  if (!colors || colors.length !== THEME_ANSI_KEYS.length) return undefined;
  return Object.fromEntries(THEME_ANSI_KEYS.map((key, index) => [key, colors[index]])) as AnsiSlots;
}

