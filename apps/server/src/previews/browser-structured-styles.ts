import type { PreviewTheme } from './browser-structured-shared.js';

export function injectStyles(theme: PreviewTheme) {
  const dark = theme.dark;
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --st-key: ${dark ? 'color-mix(in srgb, #c77dbb 90%, var(--fg))' : 'color-mix(in srgb, #871094 86%, var(--fg))'};
      --st-str: ${dark ? 'color-mix(in srgb, #6aab73 90%, var(--fg))' : 'color-mix(in srgb, #067d17 88%, var(--fg))'};
      --st-num: ${dark ? 'color-mix(in srgb, #2aacb8 90%, var(--fg))' : 'color-mix(in srgb, #1750eb 88%, var(--fg))'};
      --st-bool: ${dark ? 'color-mix(in srgb, #cf8e6d 90%, var(--fg))' : 'color-mix(in srgb, #0033b3 88%, var(--fg))'};
      --st-null: color-mix(in srgb, var(--fg) 46%, transparent);
      --st-tag: ${dark ? 'color-mix(in srgb, #d5b778 90%, var(--fg))' : 'color-mix(in srgb, #0033b3 88%, var(--fg))'};
      --st-attr: ${dark ? 'color-mix(in srgb, #56a8f5 90%, var(--fg))' : 'color-mix(in srgb, #174ad4 88%, var(--fg))'};
      --st-muted: color-mix(in srgb, var(--fg) 56%, transparent);
      --st-subtle: color-mix(in srgb, var(--fg) 3.5%, var(--bg));
      --st-hover: color-mix(in srgb, var(--fg) 5%, transparent);
      --st-selected: color-mix(in srgb, var(--accent) 12%, transparent);
      --st-guide: color-mix(in srgb, var(--line) 72%, transparent);
      --st-border: color-mix(in srgb, var(--line) 78%, transparent);
      --st-mark: color-mix(in srgb, var(--accent) 26%, transparent);
      --st-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --st-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--st-sans);
      font-size: 12.5px;
      line-height: 1.5;
    }
    #st-root {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100%;
      overflow: hidden;
    }
    .st-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--st-border);
      background: var(--bg);
      flex-shrink: 0;
      min-height: 38px;
    }
    .st-search-wrap {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 1 1 0;
      min-width: 64px;
      height: 26px;
      padding: 0 6px;
      border-radius: 6px;
      border: 1px solid var(--st-border);
      background: var(--st-subtle);
    }
    .st-search-wrap:focus-within {
      border-color: var(--accent);
      background: var(--bg);
    }
    .st-search-icon {
      width: 13px;
      height: 13px;
      color: var(--st-muted);
      pointer-events: none;
      flex-shrink: 0;
    }
    .st-search {
      flex: 1 1 0;
      width: 0;
      min-width: 0;
      height: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--fg);
      font-size: 12px;
      font-family: var(--st-sans);
      outline: none;
    }
    .st-search::placeholder {
      color: var(--st-muted);
    }
    .st-search-meta {
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--st-muted);
      pointer-events: none;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .st-search-clear {
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--st-muted);
      display: inline-grid;
      place-items: center;
      cursor: pointer;
      flex-shrink: 0;
    }
    .st-search-clear:hover {
      background: var(--st-hover);
      color: var(--fg);
    }
    .st-search-clear[hidden] { display: none; }
    .st-search-clear svg, .st-btn svg {
      width: 13px;
      height: 13px;
      display: block;
    }
    .st-seg {
      display: inline-flex;
      align-items: center;
      padding: 2px;
      border-radius: 7px;
      background: var(--st-subtle);
      border: 1px solid var(--st-border);
      flex-shrink: 0;
    }
    .st-seg button {
      border: 0;
      background: transparent;
      color: var(--st-muted);
      font-size: 11.5px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: 5px;
      line-height: 1.4;
      cursor: pointer;
      white-space: nowrap;
    }
    .st-seg button:hover {
      color: var(--fg);
    }
    .st-seg button[aria-selected="true"] {
      background: var(--bg);
      color: var(--fg);
      box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
    }
    .st-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .st-btn {
      height: 26px;
      min-width: 26px;
      padding: 0 6px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--st-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      font-size: 11.5px;
      cursor: pointer;
      white-space: nowrap;
    }
    .st-btn[hidden] { display: none; }
    .st-btn:hover:not(:disabled) {
      background: var(--st-hover);
      color: var(--fg);
    }
    .st-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .st-btn.is-ok {
      color: var(--st-str);
    }
    .st-notice {
      padding: 4px 12px;
      font-size: 11.5px;
      color: var(--st-muted);
      background: var(--st-subtle);
      border-bottom: 1px solid var(--st-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-shrink: 0;
    }
    .st-notice[hidden] { display: none; }
    .st-stage {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Tree view */
    .st-tree-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 8px 10px 20px;
      font-family: var(--st-mono);
      font-size: 12.5px;
      line-height: 1.62;
    }
    .st-node {
      position: relative;
    }
    .st-row {
      display: flex;
      align-items: flex-start;
      gap: 4px;
      padding: 1px 6px 1px 2px;
      border-radius: 4px;
      min-height: 22px;
    }
    .st-row:hover {
      background: var(--st-hover);
    }
    .st-toggle {
      width: 16px;
      height: 20px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--st-muted);
      display: inline-grid;
      place-items: center;
      flex-shrink: 0;
      cursor: pointer;
      border-radius: 3px;
    }
    .st-toggle:hover {
      color: var(--fg);
      background: var(--st-hover);
    }
    .st-toggle svg {
      width: 10px;
      height: 10px;
      transition: transform 0.1s ease;
    }
    .st-node.is-open > .st-row > .st-toggle svg {
      transform: rotate(90deg);
    }
    .st-spacer {
      width: 16px;
      flex-shrink: 0;
    }
    .st-content {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }
    .st-row-summary {
      cursor: pointer;
    }
    .st-key {
      color: var(--st-key);
      font-weight: 500;
    }
    .st-idx {
      color: var(--st-muted);
      font-variant-numeric: tabular-nums;
    }
    .st-colon {
      color: var(--st-muted);
      margin-right: 5px;
    }
    .st-brace {
      color: var(--st-muted);
    }
    .st-count {
      color: var(--st-muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      margin-left: 4px;
    }
    .st-inline-preview {
      color: var(--st-muted);
      margin-left: 6px;
      font-size: 12px;
    }
    .st-node.is-open > .st-row .st-inline-preview {
      display: none;
    }
    .st-children {
      margin-left: 8px;
      padding-left: 12px;
      border-left: 1px solid var(--st-guide);
    }
    .st-close-brace {
      padding-left: 22px;
      color: var(--st-muted);
      line-height: 1.5;
    }
    .st-str { color: var(--st-str); }
    .st-num { color: var(--st-num); font-variant-numeric: tabular-nums; }
    .st-bool { color: var(--st-bool); font-weight: 500; }
    .st-null { color: var(--st-null); font-style: italic; }
    .st-tag { color: var(--st-tag); font-weight: 500; }
    .st-attr-name { color: var(--st-attr); }
    .st-attr-val { color: var(--st-str); }
    .st-pill {
      margin-left: 6px;
      padding: 0 6px;
      height: 18px;
      font-size: 11px;
      font-family: var(--st-sans);
      border-radius: 4px;
      border: 1px solid var(--st-border);
      background: var(--st-subtle);
      color: var(--st-muted);
      cursor: pointer;
      vertical-align: middle;
    }
    .st-pill:hover {
      color: var(--fg);
      border-color: var(--line);
    }
    .st-str-block {
      margin: 4px 0 6px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--st-border);
      background: var(--st-subtle);
      color: var(--st-str);
      font-family: var(--st-mono);
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 360px;
      overflow: auto;
    }
    .st-row-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      opacity: 0;
      flex-shrink: 0;
      margin-left: 6px;
      transition: opacity 0.1s ease;
    }
    .st-row:hover .st-row-actions,
    .st-row:focus-within .st-row-actions {
      opacity: 1;
    }
    @media (hover: none) {
      .st-row-actions { opacity: 0.75; }
    }
    .st-mini-btn {
      border: 0;
      background: transparent;
      color: var(--st-muted);
      font-family: var(--st-sans);
      font-size: 11px;
      padding: 0 5px;
      height: 20px;
      border-radius: 4px;
      cursor: pointer;
    }
    .st-mini-btn:hover {
      background: var(--st-hover);
      color: var(--fg);
    }
    .st-mini-btn.is-ok {
      color: var(--st-str);
    }

    /* Table + Inspector view */
    .st-table-pane {
      flex: 1;
      min-height: 120px;
      overflow: auto;
      position: relative;
    }
    table.st-table {
      border-collapse: separate;
      border-spacing: 0;
      min-width: 100%;
      width: max-content;
      font-size: 12px;
      line-height: 1.45;
    }
    .st-table th, .st-table td {
      padding: 6px 10px;
      border-bottom: 1px solid var(--st-border);
      border-right: 1px solid color-mix(in srgb, var(--st-border) 55%, transparent);
      text-align: left;
      vertical-align: middle;
      white-space: nowrap;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .st-table thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--st-subtle);
      color: var(--fg);
      font-weight: 600;
      font-size: 11.5px;
      border-bottom: 1px solid var(--st-border);
    }
    .st-table th.st-col-num, .st-table td.st-col-num {
      position: sticky;
      left: 0;
      z-index: 1;
      background: var(--bg);
      color: var(--st-muted);
      text-align: right;
      font-family: var(--st-mono);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      width: 44px;
      min-width: 44px;
      max-width: 60px;
      border-right: 1px solid var(--st-border);
    }
    .st-table thead th.st-col-num {
      z-index: 3;
      background: var(--st-subtle);
    }
    .st-table tbody tr {
      cursor: pointer;
    }
    .st-table tbody tr:hover td {
      background: var(--st-hover);
    }
    .st-table tbody tr:hover td.st-col-num {
      background: color-mix(in srgb, var(--fg) 5%, var(--bg));
    }
    .st-table tbody tr.is-selected td {
      background: var(--st-selected);
    }
    .st-table tbody tr.is-selected td.st-col-num {
      background: color-mix(in srgb, var(--accent) 12%, var(--bg));
      color: var(--fg);
      font-weight: 600;
    }
    .st-cell-mono {
      font-family: var(--st-mono);
      font-size: 11.5px;
    }
    .st-cell-summary {
      font-family: var(--st-mono);
      font-size: 11.5px;
      color: var(--st-muted);
    }
    .st-cell-empty {
      color: var(--st-null);
    }
    .st-resizer {
      height: 5px;
      cursor: row-resize;
      background: transparent;
      border-top: 1px solid var(--st-border);
      flex-shrink: 0;
    }
    .st-resizer:hover {
      border-top-color: var(--accent);
    }
    .st-resizer[hidden], .st-inspector[hidden] { display: none; }
    .st-inspector {
      height: 44%;
      min-height: 120px;
      max-height: 78%;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      flex-shrink: 0;
    }
    .st-inspector-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      min-height: 32px;
      border-bottom: 1px solid var(--st-border);
      background: var(--st-subtle);
      flex-shrink: 0;
    }
    .st-inspector-title {
      font-size: 12px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .st-inspector-badge {
      font-family: var(--st-mono);
      font-size: 11px;
      font-weight: 400;
      color: var(--st-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .st-sentinel {
      height: 1px;
    }

    /* Source view */
    .st-source-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 8px 0 20px;
      font-family: var(--st-mono);
      font-size: 12.5px;
      line-height: 1.58;
    }
    .st-src-line {
      display: flex;
      padding: 0 12px 0 0;
    }
    .st-src-line:hover {
      background: var(--st-hover);
    }
    .st-src-num {
      width: 52px;
      padding-right: 12px;
      text-align: right;
      color: var(--st-muted);
      font-variant-numeric: tabular-nums;
      user-select: none;
      flex-shrink: 0;
    }
    .st-src-code {
      flex: 1;
      min-width: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .st-mark {
      background: var(--st-mark);
      color: inherit;
      border-radius: 2px;
      padding: 0 1px;
    }
    .st-empty {
      padding: 32px 16px;
      text-align: center;
      color: var(--st-muted);
      font-size: 12.5px;
    }
  `;
  document.head.append(style);
}
