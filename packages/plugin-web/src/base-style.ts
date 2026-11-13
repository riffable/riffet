/*
 * The base stylesheet of an isolated view's page. The web host writes it into the page it builds
 * (apps/web/src/plugins/isolated/document.ts) and the Mac host carries the same text, generated into
 * apps/macos/Riffet/Features/Inspector/PluginPageDocument.swift by `pnpm gen:plugin-style`.
 *
 * Every value is one the app already uses (apps/web/src/styles/index.css, components/ui/button.tsx
 * and controls.tsx, docs/design/riffet-style.md), so plain HTML in a view looks like the app. Two layers:
 * `--riffet-*` custom properties, and element rules wrapped in `:where()` (specificity zero), so a
 * package's own CSS wins without `!important`. Colours are the palette roles the page already receives.
 * A change to the text that is not purely additive bumps `PLUGIN_BASE_STYLE_VERSION`.
 */

export const PLUGIN_BASE_STYLE_VERSION = 1;

const FOCUS = 'color-mix(in srgb,var(--accent) 50%,transparent)';
const TEXT_FIELD = 'input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=color],[type=button],[type=submit],[type=reset],[type=image])';
const PUSH_BUTTON = 'button,input[type=button],input[type=submit],input[type=reset]';

export const PLUGIN_BASE_STYLE: string = [
  // Tokens.
  ':root{'
    + '--riffet-space-1:4px;--riffet-space-2:8px;--riffet-space-3:12px;--riffet-space-4:16px;--riffet-space-5:24px;'
    + '--riffet-radius-control:8px;--riffet-radius-container:10px;--riffet-radius-card:12px;'
    + '--riffet-font-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI","Helvetica Neue",sans-serif;'
    + '--riffet-font-mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,"PingFang SC",monospace;'
    + '--riffet-text-reading:14px;--riffet-leading-reading:23px;--riffet-text-ui:13px;--riffet-leading-ui:20px;--riffet-text-small:12px;--riffet-leading-small:16px;'
    + '--riffet-control-height:32px;--riffet-border-width:1px;'
    + `--riffet-focus-ring:${FOCUS}}`,
  // Elements.
  ':where(html,body){margin:0;height:100%}',
  ':where(body){background:var(--bg);color:var(--fg);font:var(--riffet-text-ui)/var(--riffet-leading-ui) var(--riffet-font-sans);-webkit-font-smoothing:antialiased}',
  ':where(a){color:var(--accent);text-decoration:none}',
  ':where(a:hover){text-decoration:underline;text-underline-offset:3px}',
  ':where(button,input,textarea,select){box-sizing:border-box;margin:0;font:inherit;color:inherit}',
  `:where(${PUSH_BUTTON}){display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--riffet-control-height);padding:0 12px;border:var(--riffet-border-width) solid var(--line-strong);border-radius:var(--riffet-radius-control);background:var(--bg-elevated);font-weight:500;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none;transition:background-color .15s}`,
  `:where(${PUSH_BUTTON.split(',').map((s) => `${s}:hover:not(:disabled)`).join(',')}){background:var(--bg-subtle)}`,
  `:where(${PUSH_BUTTON.split(',').map((s) => `${s}:disabled`).join(',')}){opacity:.45;cursor:default}`,
  `:where(${TEXT_FIELD},textarea,select){width:100%;min-width:0;height:var(--riffet-control-height);padding:0 10px;border:var(--riffet-border-width) solid var(--line-strong);border-radius:var(--riffet-radius-control);background:var(--bg-elevated);outline:none;transition:border-color .15s,box-shadow .15s}`,
  ':where(textarea){height:auto;min-height:80px;padding:8px 10px;line-height:20px;resize:vertical}',
  `:where(${TEXT_FIELD}:hover,textarea:hover,select:hover){border-color:color-mix(in srgb,var(--fg-4) 60%,transparent)}`,
  `:where(${TEXT_FIELD}:focus,textarea:focus,select:focus){border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 15%,transparent)}`,
  ':where(input,textarea,select)::placeholder{color:var(--fg-4)}',
  ':where(input,textarea,select):disabled{opacity:.5}',
  ':where(:focus-visible){outline:2px solid var(--riffet-focus-ring);outline-offset:1px}',
  ':where(input,textarea,select):focus-visible{outline:none}',
  '::selection{background:color-mix(in srgb,var(--accent) 24%,transparent)}',
  ':where(code,kbd,samp,pre){font-family:var(--riffet-font-mono);font-size:.86em}',
  ':where(pre){margin:0;padding:var(--riffet-space-2) var(--riffet-space-3);overflow:auto;border:var(--riffet-border-width) solid var(--line);border-radius:var(--riffet-radius-container);background:var(--bg-subtle);font-size:var(--riffet-text-small);line-height:var(--riffet-leading-ui)}',
  ':where(pre code){font-size:inherit}',
  ':where(hr){margin:var(--riffet-space-4) 0;border:0;border-top:var(--riffet-border-width) solid var(--line)}',
  ':where(table){border-collapse:collapse}',
  ':where(th,td){padding:7px var(--riffet-space-3);border-bottom:var(--riffet-border-width) solid var(--line);text-align:left;vertical-align:top}',
  ':where(th){background:var(--bg-subtle);color:var(--fg-2);font-weight:500}',
  ':where(*){scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}',
  ':where(*)::-webkit-scrollbar{width:10px;height:10px}',
  ':where(*)::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;background:var(--line-strong) padding-box}',
  ':where(*)::-webkit-scrollbar-thumb:hover{background:var(--fg-4) padding-box}',
  ':where(*)::-webkit-scrollbar-track,:where(*)::-webkit-scrollbar-corner{background:transparent}',
].join('\n');
