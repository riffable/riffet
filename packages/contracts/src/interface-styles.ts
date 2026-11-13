/**
 * Desktop interface styles (界面风格): which components a workbench is drawn with, as data.
 *
 * A style is three layers. `recipes` picks one form per component family; a client keeps one
 * implementation per form and composes them, so a new style that recombines existing forms is a
 * new entry here and no new view code. `tokens` sizes them: a number, or the name of a token in
 * `apps/web/src/styles/index.css`, which `scripts/gen-interface-styles.ts` resolves at generation
 * so a style drawn after the web follows it when the stylesheet changes. Colours stay with the
 * palette (theme), which every style combines with.
 *
 * The macOS app consumes the generated `Theme/InterfaceStyles.swift`; Android's styles
 * (`THEME_INTERFACE_STYLES`) predate this and may move onto the same vocabulary.
 */

export const DESKTOP_STYLE_RECIPES = {
  /** The system's components (toolbar, sidebar list, forms) or the app's own drawing. */
  backend: ['native', 'custom'],
  /** The system title bar the traffic lights sit in: a toolbar's (52pt, a 26pt window corner on macOS 26); the compact toolbar's (40pt, a 20pt corner). `layout.header` matches it. */
  titleBar: ['unified', 'compact'],
  /** System split view; the sidebar on the canvas beside an inset content card, edged by its colour; one flat opaque sheet with a hairline, which no window material shows through. */
  window: ['system', 'insetCard', 'flat'],
  /** System list grouped by time or project; a project tree with relative times; Pinned / recent / older groups. */
  sidebar: ['systemList', 'projectTree', 'timeGroups'],
  /** Toolbar title stack; conversation tabs inside the content; a title with its menu over a hairline. */
  header: ['toolbar', 'sessionTabs', 'titleMenu'],
  /** Inspector tabs; an outline of turns and outputs beside an inspector card; one panel per header icon. */
  rightPanel: ['inspector', 'outline', 'panels'],
  /** A card with its controls inside; one line with the environment underneath. */
  composer: ['card', 'line'],
  /** A run of tool calls: one summary line that opens to plain rows; the same summary over a bordered list. */
  toolRun: ['summary', 'list'],
  /** The new-conversation page: the composer in the middle over action tiles; options in the middle and the composer docked at the bottom. */
  home: ['tiles', 'docked'],
  /** A permission request: options and full-width buttons stacked; option rows with the buttons trailing; options in one line beside the buttons. */
  approval: ['stack', 'rows', 'inline'],
  /** A separate Settings window; a sheet inside the workbench. */
  settings: ['window', 'modal'],
  /** A card on the page (docked cards, the composer, cards in a list): lifted by a soft shadow; drawn by a hairline alone. Menus and popovers float either way. */
  surface: ['raised', 'outlined'],
  /** A block set in the content (code, tool output, tables, inline code, previews, chips): a tinted fill; a hairline on the page's paper. */
  block: ['filled', 'outlined'],
  /** A form (Settings and its sheets): the system's grouped boxes and bezels; bare rows split by hairlines under each section's title, the fields, pop-ups and segmented choices outlined on the paper. */
  form: ['grouped', 'lined'],
  /** Menus opened from the app's own controls: the system's (Liquid Glass on macOS 26); drawn on the page's paper with a hairline and a shadow. Right-click menus stay the system's. */
  menu: ['system', 'drawn'],
  /** The palette's active wash; a filled block. */
  selection: ['wash', 'block'],
} as const;

export type DesktopStyleRecipes = { [K in keyof typeof DESKTOP_STYLE_RECIPES]: (typeof DESKTOP_STYLE_RECIPES)[K][number] };

/** Points, or a web stylesheet token (`--radius-2xl`) resolved when generating. */
export type DesktopStyleLength = number | `--${string}`;

export interface DesktopStyleTokens {
  /** Rows, chips, buttons, single-line fields; code blocks, menus, popups; cards; the composer and other floating surfaces. */
  radii: { control: DesktopStyleLength; container: DesktopStyleLength; card: DesktopStyleLength; floating: DesktopStyleLength };
  /** Default sidebar width, a conversation row's height, the space above each of its groups, the content header's height, the right panel's width. */
  layout: { sidebarWidth: number; sidebarRow: number; sidebarGap: number; header: number; rightPanel: number };
  /** Interface text: rows and controls, secondary text, section labels, and the sidebar's rows (navigation, projects, conversations). */
  text: { body: DesktopStyleLength; secondary: DesktopStyleLength; label: DesktopStyleLength; sidebar: DesktopStyleLength };
  /**
   * The icon pack drawn by default (the reader can pick another, as on Android): `sf-symbols`, the
   * system's; `web`, the glyphs the web client draws; or a built-in pack id (`lucide`, `phosphor`…).
   */
  icons: string;
  /** Typefaces for interface text and code: `system`, or a family the app bundles. A plugin's appearance fonts win over both. */
  fonts: { ui: string; mono: string };
}

export interface DesktopStyle {
  id: string;
  recipes: DesktopStyleRecipes;
  tokens: DesktopStyleTokens;
}

export const DESKTOP_STYLES: readonly DesktopStyle[] = [
  {
    // The system's own components: what the Mac app has always drawn.
    id: 'native',
    recipes: { backend: 'native', titleBar: 'unified', window: 'system', sidebar: 'systemList', header: 'toolbar', rightPanel: 'inspector', composer: 'card', toolRun: 'summary', approval: 'stack', home: 'tiles', settings: 'window', surface: 'raised', block: 'filled', form: 'grouped', menu: 'system', selection: 'wash' },
    tokens: {
      radii: { control: 6, container: 10, card: 10, floating: 14 },
      layout: { sidebarWidth: 248, sidebarRow: 28, sidebarGap: 12, header: 52, rightPanel: 340 },
      text: { body: 13, secondary: 12, label: 11, sidebar: 13 },
      icons: 'sf-symbols',
      fonts: { ui: 'system', mono: 'system' },
    },
  },
  {
    // Drawn after the web client: its stylesheet is the source of these sizes.
    id: 'riffet',
    recipes: { backend: 'custom', titleBar: 'unified', window: 'insetCard', sidebar: 'projectTree', header: 'sessionTabs', rightPanel: 'outline', composer: 'card', toolRun: 'summary', approval: 'rows', home: 'tiles', settings: 'modal', surface: 'raised', block: 'filled', form: 'grouped', menu: 'drawn', selection: 'block' },
    tokens: {
      radii: { control: '--radius-md', container: '--radius-lg', card: '--radius-xl', floating: '--radius-2xl' },
      layout: { sidebarWidth: 236, sidebarRow: 30, sidebarGap: 8, header: 44, rightPanel: 320 },
      // The web's sidebar sets its rows a step below body text.
      text: { body: '--text-base', secondary: '--text-sm', label: '--text-xs', sidebar: '--text-sm' },
      // The web's desktop typefaces and icons.
      icons: 'web',
      fonts: { ui: 'Inter', mono: 'JetBrains Mono' },
    },
  },
  {
    // Line (线条): one warm sheet, hairlines for every edge, panels opened from the header.
    id: 'line',
    recipes: { backend: 'custom', titleBar: 'compact', window: 'flat', sidebar: 'timeGroups', header: 'titleMenu', rightPanel: 'panels', composer: 'line', toolRun: 'list', approval: 'inline', home: 'docked', settings: 'modal', surface: 'outlined', block: 'outlined', form: 'lined', menu: 'drawn', selection: 'block' },
    tokens: {
      // Measured on Claude Desktop: rows, the mode switch and code blocks round by 8pt.
      radii: { control: 8, container: 8, card: 10, floating: 12 },
      // Rows a little taller and groups further apart than the system list. The header is the
      // compact title bar's height, so its title sits level with the traffic lights and the window
      // keeps the smaller corner.
      layout: { sidebarWidth: 248, sidebarRow: 34, sidebarGap: 18, header: 40, rightPanel: 340 },
      text: { body: 14, secondary: 13, label: 12, sidebar: 14 },
      // Claude Desktop sets its interface in the system face, with thin outlined icons.
      icons: 'lucide',
      fonts: { ui: 'system', mono: 'system' },
    },
  },
];
