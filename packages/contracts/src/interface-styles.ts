/**
 * The desktop client's sizes, faces and icons (the Riffet style), as data.
 *
 * The Mac draws one style, after the web client (docs/design/riffet-style.md). A length is a number
 * or the name of a token in `apps/web/src/styles/index.css`, which `scripts/gen-interface-styles.ts`
 * resolves at generation, so the Mac follows the web when the stylesheet changes. Colours stay with
 * the palette (theme). The macOS app consumes the generated `Theme/InterfaceStyles.swift`.
 */

/** Points, or a web stylesheet token (`--radius-2xl`) resolved when generating. */
export type DesktopStyleLength = number | `--${string}`;

export interface DesktopStyle {
  /** Rows, chips, buttons, single-line fields; code blocks and a menu's rows; cards; the composer and other floating surfaces; menus and popovers. */
  radii: { control: DesktopStyleLength; container: DesktopStyleLength; card: DesktopStyleLength; floating: DesktopStyleLength; menu: DesktopStyleLength };
  /** Default sidebar width, a conversation row's height, the space above each of its groups, the content header's height, the right panel's width. */
  layout: { sidebarWidth: number; sidebarRow: number; sidebarGap: number; header: number; rightPanel: number };
  /** Interface text: rows and controls, secondary text, section labels, and the sidebar's rows (navigation, projects, conversations); then the line height of the transcript's prose, before the reader's text scale. */
  text: { body: DesktopStyleLength; secondary: DesktopStyleLength; label: DesktopStyleLength; sidebar: DesktopStyleLength; readingLine: number };
  /**
   * The icon pack drawn by default (the reader can pick another): `sf-symbols`, the system's; `web`,
   * the glyphs the web client draws; or a built-in pack id (`lucide`, `phosphor`…).
   */
  icons: string;
  /** Typefaces for interface text and code: `system`, or a family the app bundles. A plugin's appearance fonts win over both. */
  fonts: { ui: string; mono: string };
}

export const DESKTOP_STYLE: DesktopStyle = {
  radii: { control: '--radius-md', container: '--radius-lg', card: '--radius-xl', floating: '--radius-2xl', menu: '--radius-xl' },
  layout: { sidebarWidth: 236, sidebarRow: 30, sidebarGap: 8, header: 44, rightPanel: 320 },
  // Three sizes for the chrome (docs/design/riffet-style.md §2): rows and controls, then
  // secondary text and section labels a step below; prose (14pt) on a tighter line than 1.8.
  text: { body: '--text-sm', secondary: '--text-xs', label: '--text-xs', sidebar: '--text-sm', readingLine: 23 },
  // The web's desktop typefaces and icons.
  icons: 'web',
  fonts: { ui: 'Inter', mono: 'JetBrains Mono' },
};
