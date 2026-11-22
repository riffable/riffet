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
  var CODE_THEME_ROLES = [
    'comment', 'keyword', 'string', 'number', 'constant', 'declaration', 'type',
    'property', 'namespace', 'tag', 'attribute', 'annotation', 'escape', 'heading'
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

  function readSyntaxHalf(value) {
    if (!value || typeof value !== 'object' || !value.colors || typeof value.colors !== 'object') return null;
    var colors = {};
    for (var index = 0; index < CODE_THEME_ROLES.length; index++) {
      var role = CODE_THEME_ROLES[index];
      var color = value.colors[role];
      if (typeof color !== 'string' || !ROLE_COLOR.test(color)) return null;
      colors[role] = color.toLowerCase();
    }
    return { colors: colors, commentItalic: typeof value.commentItalic === 'boolean' ? value.commentItalic : true };
  }

  function readSyntax(value) {
    if (!value || typeof value !== 'object') return null;
    var light = readSyntaxHalf(value.light);
    var dark = readSyntaxHalf(value.dark);
    return light && dark ? { light: light, dark: dark } : null;
  }

  function readGradientHalf(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.angle !== 'number' || !isFinite(value.angle) || value.angle < 0 || value.angle > 360) return null;
    if (!Array.isArray(value.colors) || value.colors.length < 2 || value.colors.length > 3) return null;
    var colors = [];
    for (var index = 0; index < value.colors.length; index++) {
      if (typeof value.colors[index] !== 'string' || !ANSI_COLOR.test(value.colors[index])) return null;
      colors.push(value.colors[index].toLowerCase());
    }
    return { colors: colors, angle: value.angle };
  }

  function readGradient(value) {
    if (!value || typeof value !== 'object') return null;
    var light = readGradientHalf(value.light);
    var dark = readGradientHalf(value.dark);
    if (!light || !dark) return null;
    var blend = typeof value.blend === 'number' && isFinite(value.blend) && value.blend >= 0 && value.blend <= 1 ? value.blend : 0.25;
    return { light: light, dark: dark, blend: blend };
  }

  function cardBgCss(gradient) {
    if (!gradient) return 'var(--bg)';
    var blend = Math.min(1, Math.max(0, typeof gradient.blend === 'number' ? gradient.blend : 0.25));
    if (blend <= 0) return 'var(--bg)';
    if (blend >= 1) return 'transparent';
    var pct = Math.round((1 - blend) * 1000) / 10;
    return 'color-mix(in srgb, var(--bg) ' + pct + '%, transparent)';
  }

  function gradientCss(half) {
    if (!half || !half.colors || half.colors.length < 2) return 'none';
    var c0 = half.colors[0];
    var c1 = half.colors[1];
    var c2 = half.colors[2];
    if (c2) {
      var perp = ((half.angle + 90) * Math.PI) / 180;
      var x = Math.round((50 + 45 * Math.sin(perp)) * 10) / 10;
      var y = Math.round((50 - 45 * Math.cos(perp)) * 10) / 10;
      return 'radial-gradient(110% 110% at ' + x + '% ' + y + '%, ' + c1 + ' 0%, ' + c1 + '00 72%), linear-gradient(' + half.angle + 'deg, ' + c0 + ' 0%, ' + c2 + ' 100%)';
    }
    return 'linear-gradient(' + half.angle + 'deg, ' + c0 + ' 0%, ' + c1 + ' 100%)';
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
    var syntax = value.syntax !== undefined ? readSyntax(value.syntax) : null;
    var gradient = value.gradient !== undefined ? readGradient(value.gradient) : null;
    return { id: value.id, light: light, dark: dark, syntax: syntax, gradient: gradient };
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
      var syntax = value.syntax !== undefined ? readSyntax(value.syntax) : null;
      return light && dark ? { id: value.key, light: light, dark: dark, syntax: syntax } : null;
    } catch (_) { return null; }
  }

  function block(selector, scheme, palette, gradientHalf, cardBg) {
    var lines = [selector + ' {', '  color-scheme: ' + scheme + ';'];
    for (var index = 0; index < THEME_ROLES.length; index++) {
      var role = THEME_ROLES[index];
      lines.push('  --' + role + ': ' + palette[role] + ';');
    }
    lines.push('  --bg-canvas-gradient: ' + (gradientHalf ? gradientCss(gradientHalf) : 'none') + ';');
    lines.push('  --bg-card: ' + (cardBg || 'var(--bg)') + ';');
    lines.push('}');
    return lines.join('\n');
  }

  function syntaxBlock(selector, half, isDark) {
    var fgMix = isDark ? 90 : 88;
    var commentMix = isDark ? 85 : 80;
    var lines = [selector + ' {', '  --code-comment-style: ' + (half.commentItalic ? 'italic' : 'normal') + ';'];
    for (var index = 0; index < CODE_THEME_ROLES.length; index++) {
      var role = CODE_THEME_ROLES[index];
      var hex = half.colors[role];
      var target = role === 'comment'
        ? 'color-mix(in oklab, ' + hex + ' ' + commentMix + '%, var(--fg-3))'
        : 'color-mix(in oklab, ' + hex + ' ' + fgMix + '%, var(--fg))';
      lines.push('  --code-' + role + ': ' + target + ';');
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
      var cardBg = cardBgCss(theme.gradient);
      var parts = [
        block('[data-theme="' + theme.id + '"]:not(.dark)', 'light', theme.light, theme.gradient && theme.gradient.light, cardBg),
        block('[data-theme="' + theme.id + '"].dark', 'dark', theme.dark, theme.gradient && theme.gradient.dark, cardBg)
      ];
      if (theme.syntax) {
        parts.push(
          syntaxBlock('[data-code-theme="' + theme.id + '"]:not(.dark)', theme.syntax.light, false),
          syntaxBlock('[data-code-theme="' + theme.id + '"].dark', theme.syntax.dark, true)
        );
      }
      return parts.join('\n\n');
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
  var CODE_THEMES = ['intellij', 'github', 'vitesse', 'one', 'catppuccin', 'solarized', 'rose-pine', 'everforest', 'monochrome'];
  var UI_CODE_MAP = { solarized: 'solarized', catppuccin: 'catppuccin', 'rose-pine': 'rose-pine', everforest: 'everforest', pencil: 'monochrome' };
  var codeTheme = 'intellij';
  var hasCustomSyntax = function (id) {
    for (var i = 0; i < customThemes.length; i++) {
      if (customThemes[i].id === id && customThemes[i].syntax) return true;
    }
    return false;
  };
  try {
    var displayRaw = localStorage.getItem('riffet.display');
    var displayParsed = displayRaw && JSON.parse(displayRaw);
    var choice = displayParsed && displayParsed.codeTheme;
    if (typeof choice === 'string' && (CODE_THEMES.indexOf(choice) !== -1 || hasCustomSyntax(choice))) {
      codeTheme = choice;
    } else if (pluginPalette && pluginPalette.syntax) {
      codeTheme = pluginPalette.id;
    } else if (!pluginPalette && theme && hasCustomSyntax(theme)) {
      codeTheme = theme;
    } else if (!pluginPalette && theme && Object.prototype.hasOwnProperty.call(UI_CODE_MAP, theme)) {
      codeTheme = UI_CODE_MAP[theme];
    }
  } catch (_) { /* unreadable display settings: default to intellij */ }
  root.setAttribute('data-code-theme', codeTheme);

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
