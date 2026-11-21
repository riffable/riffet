import type { Category } from './model';

/*
 * One hue per kind of mark, from the chart palette in order and desaturated by the overview recipe
 * (foundations §12.1: mix about a quarter of `fg-3` in). Colour lives on the marks only: the timeline's bars,
 * a row's waterfall bar, the legend dots and the token bars; text and icons keep the gray scale. A failure
 * is drawn in `danger`, beside its text.
 */

const muted = (chart: number) => `color-mix(in oklab, var(--chart-${chart}) 74%, var(--fg-3))`;

export const CATEGORY_COLOR: Readonly<Record<Category, string>> = {
  model: muted(1),
  tool: muted(2),
  thinking: muted(3),
  message: muted(4),
  system: 'var(--fg-4)',
  draft: 'var(--fg-4)',
};

/** Token series, in the order a request is read: what went in, then what came out. */
export const TOKEN_COLOR = {
  input: muted(1),
  cacheRead: `color-mix(in oklab, var(--chart-1) 40%, var(--fg-4))`,
  cacheWrite: muted(3),
  output: muted(2),
  reasoning: muted(4),
} as const;

/** CSS colours resolved to `rgb()` for a canvas, which cannot read variables; read again when the theme changes. */
export function resolveColors<K extends string>(colors: Readonly<Record<K, string>>): Record<K, string> {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const out = {} as Record<K, string>;
  for (const key of Object.keys(colors) as K[]) {
    probe.style.color = '';
    probe.style.color = colors[key];
    out[key] = getComputedStyle(probe).color || 'gray';
  }
  probe.remove();
  return out;
}
