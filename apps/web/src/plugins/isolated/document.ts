import { THEME_ROLES } from '@contracts';
import { PLUGIN_BASE_STYLE, type BridgeTheme } from '@riffet/plugin-web';

/*
 * The server delivers the sandboxed shell. The web host sends the palette and
 * `PLUGIN_BASE_STYLE` at the handshake, then pushes theme changes over the bridge.
 */

/** The embedding policy of the iframe. The server's shell enforces these directives too. */
export function pluginPolicy(network: boolean): string {
  return [
    "default-src 'none'", "script-src 'unsafe-inline' blob:", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
    `connect-src ${network ? 'https:' : "'none'"}`, "base-uri 'none'", "form-action 'none'",
  ].join('; ');
}

/** A colour value that is safe to write into a style rule: the palette's own forms, nothing that could close the rule or the element. */
const SAFE_VALUE = /^[#(),.%\w\s/+-]{1,80}$/;

/** The colour roles of the palette in effect on the app's document element, and the text scale. */
export function readTheme(root: HTMLElement = document.documentElement): BridgeTheme {
  const style = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const role of THEME_ROLES) {
    const value = style.getPropertyValue(`--${role}`).trim();
    if (SAFE_VALUE.test(value)) vars[`--${role}`] = value;
  }
  // The reader's text size: the page's text tokens multiply by it (`PLUGIN_BASE_STYLE`).
  const scale = style.getPropertyValue('--text-scale').trim();
  if (SAFE_VALUE.test(scale)) vars['--text-scale'] = scale;
  return { scheme: root.classList.contains('dark') ? 'dark' : 'light', vars };
}

export function bootstrapStyle(theme: BridgeTheme): string {
  const vars = Object.entries(theme.vars).filter(([name, value]) => /^--[a-z0-9-]+$/.test(name) && SAFE_VALUE.test(value)).map(([name, value]) => `${name}:${value}`).join(';');
  return `:root{color-scheme:${theme.scheme};${vars}}${PLUGIN_BASE_STYLE}`;
}

/** Server-served sandboxed shell for isolated web views (avoids inheriting the parent document's `script-src 'self'` via `srcdoc`). */
export function pluginFrameUrl(network: boolean): string {
  return network ? '/plugin-view?network=1' : '/plugin-view';
}
