import { contrastRatio, parseColor, type Rgba } from '../packages/contracts/src/theme.js';
import type { ThemePalette } from './theme-blocks';

/**
 * The contrast rules of docs/THEMES.md §2.2, asserted over every built-in theme in both modes.
 * Interface styles (`gen-interface-styles.ts`) do not carry colours, so the palette is the whole
 * surface. Custom themes are not gated: the editor only warns. `--line*` is exempt by design.
 */

const AA = 4.5;
const NON_TEXT = 3;

const textOnBg = ['fg', 'fg-2', 'fg-3'];
const statusOnBg = ['success', 'warning', 'danger', 'agent-cursor', 'agent-codex', 'agent-claude', 'agent-dsh'];
const pairs: Array<[foreground: string, background: string, minimum: number]> = [
  ['accent-fg', 'accent', AA],
  ['danger-fg', 'danger', AA],
  ['primary-fg', 'primary', AA],
];

function colorOf(palette: Map<string, string>, role: string): Rgba {
  const value = palette.get(`--${role}`);
  const parsed = value === undefined ? null : parseColor(value);
  if (!parsed) throw new Error(`--${role} is missing or not a colour: ${value}`);
  return parsed;
}

export function themeContrastFailures(themes: readonly ThemePalette[]): string[] {
  const failures: string[] = [];
  for (const entry of themes) {
    for (const mode of ['light', 'dark'] as const) {
      const palette = entry[mode];
      const label = `${entry.id} ${mode}`;
      const bg = colorOf(palette, 'bg');
      const check = (foreground: string, background: Rgba, backgroundName: string, minimum: number) => {
        const ratio = contrastRatio(colorOf(palette, foreground), background);
        if (ratio < minimum) failures.push(`${label}: --${foreground} on --${backgroundName} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
      };
      // The ladder steps toward the page: each rung must have strictly less contrast than the last.
      const ladder = ['fg', 'fg-2', 'fg-3', 'fg-4'].map((role) => contrastRatio(colorOf(palette, role), bg));
      ladder.forEach((ratio, at) => {
        if (at > 0 && ratio >= ladder[at - 1]!) failures.push(`${label}: --fg ladder is not strictly decreasing at --fg-${at + 1} (${ratio.toFixed(2)} >= ${ladder[at - 1]!.toFixed(2)})`);
      });
      for (const role of textOnBg) check(role, bg, 'bg', AA);
      for (const role of statusOnBg) check(role, bg, 'bg', NON_TEXT);
      for (const [foreground, background, minimum] of pairs) check(foreground, colorOf(palette, background), background, minimum);
    }
  }
  return failures;
}
