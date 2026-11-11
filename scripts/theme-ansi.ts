/**
 * The 16 ANSI slots of every built-in theme, in SGR order (30–37, then 90–97).
 *
 * ANSI is curated rather than derived from the colour roles: the roles describe *this app's*
 * surfaces, while ANSI is a contract with whatever runs inside the terminal — `git diff`, `ls`, a
 * test runner — and those slots must stay mutually distinguishable in a way app colours are never
 * asked to be. Keeping the table here, rather than in each client, is what lets the generator emit
 * one copy for web, Kotlin and Swift; a custom theme carries its own sixteen values in the theme
 * library instead, so no client ever has to invent a fallback.
 *
 * Two sets are published upstream and copied verbatim:
 *   - Catppuccin ships `ansiColors` in its palette.json (normal + bright, per flavour).
 *   - Solarized's own table assigns each of its sixteen colours to an ANSI index. Its light half
 *     swaps the monotone slots (0↔7, 8↔15, 10↔14, 11↔13): Solarized serves both modes by reversing
 *     that ladder, and the dark assignment on a cream page would make ANSI 7 and 15 nearly invisible.
 *
 * The rest are mapped from each project's published accents, one hue per slot. The default theme is
 * GitHub Primer's set, carried over unchanged so adding themes did not repaint anybody's `git diff`.
 */

export interface BuiltinAnsi {
  readonly light: readonly string[];
  readonly dark: readonly string[];
}

/** `themeId` → both halves. Every id in the stylesheet must appear here; the generator asserts it. */
export const BUILTIN_ANSI: Readonly<Record<string, BuiltinAnsi>> = {
  riffet: {
    light: [
      '#24292f', '#cf222e', '#116329', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#57606a', '#a40e26', '#1a7f37', '#7d4e00', '#218bff', '#a475f9', '#3192aa', '#8c959f',
    ],
    dark: [
      '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
      '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
    ],
  },
  solarized: {
    light: [
      '#eee8d5', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#073642',
      '#fdf6e3', '#cb4b16', '#93a1a1', '#839496', '#657b83', '#6c71c4', '#586e75', '#002b36',
    ],
    dark: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
  catppuccin: {
    // Latte
    light: [
      '#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be',
      '#6c6f85', '#de293e', '#49af3d', '#eea02d', '#456eff', '#fe85d8', '#2d9fa8', '#bcc0cc',
    ],
    // Mocha
    dark: [
      '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8',
      '#585b70', '#f37799', '#89d88b', '#ebd391', '#74a8fc', '#f2aede', '#6bd7ca', '#bac2de',
    ],
  },
  'rose-pine': {
    // Dawn
    light: [
      '#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#56949f', '#797593',
      '#9893a5', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#56949f', '#464261',
    ],
    // Main
    dark: [
      '#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#9ccfd8', '#908caa',
      '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#9ccfd8', '#e0def4',
    ],
  },
  everforest: {
    light: [
      '#edeada', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#5c6a72',
      '#bec5b2', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#5c6a72',
    ],
    dark: [
      '#374145', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa',
      '#4f5b58', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa',
    ],
  },
  kiln: {
    // Warm ivory and clay. Anthropic publishes no terminal palette; these are spread across the
    // CLI's status trio, the docs system's accent-secondary (blue) and accent-pro (violet), and
    // Sky. Magenta/cyan carry violet/blue because the palette has no such hue.
    light: [
      '#3d3d3a', '#ab2b3f', '#2c7a39', '#966c1e', '#2c84db', '#5645a1', '#6a9bcc', '#73726c',
      '#73726c', '#eb5f57', '#91c882', '#fac35f', '#82aadc', '#9b82c8', '#c882b4', '#141413',
    ],
    dark: [
      '#30302e', '#ff6b80', '#4eba65', '#ffc107', '#599ee3', '#9b87f5', '#6a9bcc', '#9c9a92',
      '#9c9a92', '#fa9b93', '#b9e6b4', '#ffe19b', '#b4cdf0', '#c3b4e6', '#e6b4d2', '#faf9f5',
    ],
  },
  // Ink, Sepia, Moss, Slate, Pencil and Celadon are Riffet's own reading palettes, built on Kiln's ladder:
  // 0/7/8/15 walk the theme's own text steps, the six hues reuse its status colours where one
  // exists and add a blue, violet and teal tuned to the same paper.
  ink: {
    light: [
      '#3b3d40', '#a8323a', '#2d7a46', '#8f6a1f', '#2f5d8a', '#7a4fa0', '#23807c', '#6e7075',
      '#6e7075', '#d9534f', '#4c9a5f', '#b8862a', '#4f7fb3', '#9c6cc4', '#3a9e98', '#151617',
    ],
    dark: [
      '#2f3032', '#e5706b', '#5bb878', '#e0b04a', '#7aa6d6', '#b394e6', '#6fc2bd', '#9a9b9e',
      '#9a9b9e', '#f29b96', '#9cd9ab', '#f0d08c', '#b3cdeb', '#d2c1f2', '#a9dfdb', '#f7f7f5',
    ],
  },
  sepia: {
    light: [
      '#463f37', '#a3271f', '#4f7334', '#85621f', '#3d6a8f', '#8a4a6e', '#3f7a72', '#746c60',
      '#746c60', '#cf5a47', '#73985a', '#ad8435', '#5f8bb0', '#b06d93', '#5e9b92', '#1c1915',
    ],
    dark: [
      '#36302a', '#ec6f63', '#8fb86a', '#e3b55a', '#82a9cc', '#c99ab5', '#86bdb2', '#a0968a',
      '#a0968a', '#f5a198', '#b9d69d', '#f0d394', '#b5cde3', '#e0c2d4', '#b6dad3', '#f3ede2',
    ],
  },
  moss: {
    light: [
      '#3a3e39', '#a8323a', '#4a7a2c', '#94691c', '#33689a', '#7a4fa0', '#1f7a68', '#6c7169',
      '#6c7169', '#d4564f', '#6c9a4c', '#bb8a33', '#5288bc', '#9c6cc4', '#3a9c88', '#141614',
    ],
    dark: [
      '#2e322e', '#e8736e', '#a3b87a', '#e2b250', '#7ea6d0', '#b394e6', '#4fbfa6', '#989e95',
      '#989e95', '#f29e9a', '#c6d6a6', '#f0d18e', '#b4cbe6', '#d2c1f2', '#92dccb', '#f4f6f1',
    ],
  },
  slate: {
    light: [
      '#383c42', '#a8323a', '#2b7651', '#8e6b1f', '#3a6ea5', '#7a4fa0', '#23807c', '#696f77',
      '#696f77', '#d9534f', '#4a9a70', '#b8862a', '#5b8fc7', '#9c6cc4', '#3a9e98', '#121417',
    ],
    dark: [
      '#2c3035', '#e9706f', '#5bbd86', '#e0b04a', '#8fb0cc', '#b394e6', '#6fc2bd', '#979ca3',
      '#979ca3', '#f39d9c', '#9cdab6', '#f0d08c', '#c2d5e6', '#d2c1f2', '#a9dfdb', '#f2f4f6',
    ],
  },
  pencil: {
    light: [
      '#3a3a3a', '#a8323a', '#2f7a44', '#8c6a22', '#2f6fb3', '#7a4fa0', '#23807c', '#6f6f6f',
      '#6f6f6f', '#d9534f', '#4c9a5f', '#b8862a', '#4f8fd0', '#9c6cc4', '#3a9e98', '#111111',
    ],
    dark: [
      '#2e2e2e', '#e8706c', '#5bb878', '#e0b04a', '#6fa3e0', '#b394e6', '#6fc2bd', '#9b9b9b',
      '#9b9b9b', '#f29c99', '#9cd9ab', '#f0d08c', '#a9c8ee', '#d2c1f2', '#a9dfdb', '#f5f5f5',
    ],
  },
  celadon: {
    light: [
      '#383e3b', '#a8323a', '#3b7a35', '#8f6a1f', '#33689a', '#7a4fa0', '#2c6e68', '#69716c',
      '#69716c', '#d4564f', '#5e9a52', '#b8862a', '#5288bc', '#9c6cc4', '#3f9a90', '#121614',
    ],
    dark: [
      '#2c302e', '#e8716e', '#8fc27a', '#e0b04a', '#7ea6d0', '#b394e6', '#6fbcb3', '#969d99',
      '#969d99', '#f29d9a', '#b9daa9', '#f0d08c', '#b4cbe6', '#d2c1f2', '#a6dbd4', '#f2f5f3',
    ],
  },
};
