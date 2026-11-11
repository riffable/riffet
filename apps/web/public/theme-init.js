(function () {
  /*
   * Runs before the app bundle, so it must be self-contained: no imports, and it may only trust the
   * theme-library cache it validates itself. Its job is the first frame — pick the palette, inject
   * the custom palettes' rules, then let the React runtime take over with the same decisions.
   *
   * `THEME_ROLES` must stay identical, in the same order, to `THEME_ROLES` in
   * `packages/contracts/src/theme.ts`. The generated stylesheet is checked against that constant;
   * this copy is not, because a blocking script cannot import it.
   */
  var THEME_ROLES = [
    'bg', 'bg-sidebar', 'bg-subtle', 'bg-muted', 'bg-elevated', 'bg-popover', 'bg-hover', 'bg-active', 'bg-bubble',
    'fg', 'fg-2', 'fg-3', 'fg-4',
    'line', 'line-soft', 'line-strong',
    'primary', 'primary-hover', 'primary-fg',
    'accent', 'accent-hover', 'accent-soft', 'accent-fg',
    'success', 'success-soft',
    'warning', 'warning-soft',
    'danger', 'danger-soft', 'danger-fg',
    'diff-add', 'diff-add-gutter', 'diff-add-marker', 'diff-add-strong',
    'diff-del', 'diff-del-gutter', 'diff-del-marker', 'diff-del-strong',
    'toast', 'toast-success', 'toast-danger',
    'agent-cursor', 'agent-codex', 'agent-claude', 'agent-dsh',
    'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8'
  ];
  var LIBRARY_KEY = 'riffet.theme.library.v1';
  // Stored ids from before a rename; keep the first frame on the same palette as the runtime.
  var LEGACY_THEMES = { claude: 'kiln' };
  var STYLE_ID = 'riffet-custom-themes';
  // The plugin palette in effect, as `lib/appearance.ts` last wrote it: `{ key, light, dark }`.
  var PLUGIN_KEY = 'riffet.appearance.palette.v1';
  var PLUGIN_STYLE_ID = 'riffet-plugin-themes';
  var PLUGIN_ID_PATTERN = /^plugin-[0-9a-f]{16}$/;
  var ID_PATTERN = /^custom-[a-z0-9-]{8,64}$/;
  var ROLE_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
  var ANSI_COLOR = /^#[0-9a-f]{6}$/i;

  function readPalette(value) {
    if (!value || typeof value !== 'object') return null;
    var palette = {};
    for (var index = 0; index < THEME_ROLES.length; index++) {
      var role = THEME_ROLES[index];
      var color = value[role];
      if (typeof color !== 'string' || !ROLE_COLOR.test(color)) return null;
      palette[role] = color.toLowerCase();
    }
    return palette;
  }

  function readAnsi(value) {
    if (!Array.isArray(value) || value.length !== 16) return null;
    for (var index = 0; index < 16; index++) {
      if (typeof value[index] !== 'string' || !ANSI_COLOR.test(value[index])) return null;
    }
    return value;
  }

  function readTheme(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return null;
    var palette = value.palette;
    if (!palette || typeof palette !== 'object') return null;
    var light = readPalette(palette.light);
    var dark = readPalette(palette.dark);
    if (!light || !dark) return null;
    if (!readAnsi(value.ansi && value.ansi.light) || !readAnsi(value.ansi && value.ansi.dark)) return null;
    return { id: value.id, light: light, dark: dark };
  }

  /*
   * A theme that does not survive validation is dropped rather than allowed to fail the whole
   * library: one hand-edited entry must not cost the reader every other custom theme on startup.
   * This mirrors `validateThemeLibrary` closely enough that the runtime accepts what this emitted.
   */
  function readCustomThemes() {
    var themes = [];
    try {
      var raw = localStorage.getItem(LIBRARY_KEY);
      if (!raw) return themes;
      var library = JSON.parse(raw);
      if (!library || library.version !== 1 || !Array.isArray(library.themes)) return themes;
      for (var index = 0; index < library.themes.length; index++) {
        var theme = readTheme(library.themes[index]);
        if (theme) themes.push(theme);
      }
    } catch (_) { /* unreadable cache: fall back to the stylesheet's built-in palettes */ }
    return themes;
  }

  function readPluginPalette() {
    try {
      var raw = localStorage.getItem(PLUGIN_KEY);
      var value = raw && JSON.parse(raw);
      if (!value || typeof value.key !== 'string' || !PLUGIN_ID_PATTERN.test(value.key)) return null;
      var light = readPalette(value.light);
      var dark = readPalette(value.dark);
      return light && dark ? { id: value.key, light: light, dark: dark } : null;
    } catch (_) { return null; }
  }

  function block(selector, scheme, palette) {
    var lines = [selector + ' {', '  color-scheme: ' + scheme + ';'];
    for (var index = 0; index < THEME_ROLES.length; index++) {
      var role = THEME_ROLES[index];
      lines.push('  --' + role + ': ' + palette[role] + ';');
    }
    lines.push('}');
    return lines.join('\n');
  }

  /*
   * Same selectors the built-in palettes use, so a custom theme is indistinguishable to the rest of
   * the app: `.dark` still means the mode, `data-theme` still means the palette.
   */
  function injectCustomThemes(themes, styleId) {
    if (!themes.length) return;
    var css = themes.map(function (theme) {
      return block('[data-theme="' + theme.id + '"]:not(.dark)', 'light', theme.light) + '\n\n' +
        block('[data-theme="' + theme.id + '"].dark', 'dark', theme.dark);
    }).join('\n\n');
    var style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = css;
  }

  var mode = null;
  var theme = null;
  try {
    mode = localStorage.getItem('riffet.theme');
    theme = localStorage.getItem('riffet.theme.id');
    if (theme && LEGACY_THEMES[theme]) theme = LEGACY_THEMES[theme];
  } catch (_) { /* storage unavailable */ }

  var root = document.documentElement;
  var customThemes = readCustomThemes();
  var dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) root.classList.add('dark');
  if (theme) {
    // A custom id whose palette is not in the (validated) cache matches no block, so setting the
    // attribute would only move the app from `:root`'s defaults to the same values via no rule at
    // all. Leave it off; the runtime sets it once the library actually contains the palette.
    var isCustom = theme.indexOf('custom-') === 0;
    var resolved = !isCustom || customThemes.some(function (entry) { return entry.id === theme; });
    if (resolved) root.setAttribute('data-theme', theme);
  }
  injectCustomThemes(customThemes, STYLE_ID);
  // A plugin palette in effect is painted over the chosen theme, as the runtime does once it loads.
  var pluginPalette = readPluginPalette();
  if (pluginPalette) {
    injectCustomThemes([pluginPalette], PLUGIN_STYLE_ID);
    root.setAttribute('data-theme', pluginPalette.id);
  }

  /*
   * The browser chrome colour is read back from the applied `--bg` rather than carried here as a
   * second copy of every palette's background.
   *
   * That read has to wait for the stylesheet: the bundle's `<link rel="stylesheet">` is emitted
   * *after* this script, so on the first synchronous pass the custom property does not exist yet and
   * a hard-coded pair is what this file used to fall back on. A render-blocking stylesheet fires
   * `load` before the first paint, so listening for it keeps the meta correct at first paint without
   * duplicating a single colour.
   */
  function syncChrome() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var surface = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (surface) meta.setAttribute('content', surface);
  }
  syncChrome();
  var sheet = document.querySelector('link[rel="stylesheet"]');
  if (sheet) sheet.addEventListener('load', syncChrome);
  // Belt and braces: a bundler that inlines the CSS leaves no <link> to listen to.
  window.addEventListener('load', syncChrome, { once: true });
})();
