type PreviewTheme = { dark: boolean; foreground: string; background: string; line: string; accent: string };

interface XmlTreeNode {
  tag: string;
  attrs?: [string, string][];
  children: (XmlTreeNode | string)[];
}

type StructuredPayload = {
  kind: 'value' | 'xml';
  format: string;
  name: string;
  theme: PreviewTheme;
  clipped: boolean;
  totalLines?: number;
  value?: unknown;
  xml?: (XmlTreeNode | string)[];
  source?: string;
  sourceClipped?: boolean;
};

type ViewMode = 'table' | 'tree' | 'source';

const TABLE_PAGE = 150;
const SOURCE_PAGE = 300;
const MAX_COLUMNS = 120;
const MAX_EXPAND_ALL_NODES = 2500;
const LONG_STRING_THRESHOLD = 140;

const hasOwn = Object.prototype.hasOwnProperty;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function ownEntries(object: Record<string, unknown>): [string, unknown][] {
  const keys = Object.keys(object);
  const entries: [string, unknown][] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) entries.push([key, descriptor.value]);
  }
  return entries;
}

function ownGet(object: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
  if (!hasOwn.call(object, key)) return { present: false, value: undefined };
  return { present: true, value: Object.getOwnPropertyDescriptor(object, key)?.value };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgIcon(pathD: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  svg.append(path);
  return svg;
}

const ICONS = {
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm6.5 1.5L10.8 10.8',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  copy: 'M5.5 5.5v-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z',
  check: 'M3.5 8.5l3 3 6-6.5',
  expandAll: 'M4.5 5.5L8 2.5l3.5 3M4.5 10.5L8 13.5l3.5-3',
  collapseAll: 'M4.5 2.5L8 5.5l3.5-3M4.5 13.5L8 10.5l3.5 3',
  up: 'M4 10l4-4 4 4',
  down: 'M4 6l4 4 4-4',
};

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back to textarea selection copy inside sandboxed frames */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

function appendHighlighted(target: HTMLElement, text: string, lowerQuery: string): number {
  if (!lowerQuery) {
    target.textContent = text;
    return 0;
  }
  const lower = text.toLowerCase();
  let cursor = 0;
  let hits = 0;
  while (cursor < text.length) {
    const index = lower.indexOf(lowerQuery, cursor);
    if (index === -1) {
      target.append(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (index > cursor) target.append(document.createTextNode(text.slice(cursor, index)));
    const mark = el('mark', 'st-mark', text.slice(index, index + lowerQuery.length));
    target.append(mark);
    hits++;
    cursor = index + lowerQuery.length;
  }
  return hits;
}

function singleLinePreview(value: unknown, maxLen = 88): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ');
    return JSON.stringify(clean.length > 48 ? clean.slice(0, 48) + '…' : clean);
  }
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const parts: string[] = [];
    let len = 2;
    for (let i = 0; i < value.length && i < 5; i++) {
      const item = value[i];
      const part = isPlainObject(item)
        ? '{…}'
        : Array.isArray(item)
          ? `[${item.length}]`
          : singleLinePreview(item, 32);
      if (len + part.length > maxLen && parts.length > 0) { parts.push('…'); break; }
      parts.push(part);
      len += part.length + 2;
    }
    if (parts.length < value.length && parts[parts.length - 1] !== '…') parts.push('…');
    return `[${parts.join(', ')}]`;
  }
  const entries = ownEntries(value as Record<string, unknown>);
  if (!entries.length) return '{}';
  const parts: string[] = [];
  let len = 2;
  for (let i = 0; i < entries.length && i < 6; i++) {
    const [k, v] = entries[i]!;
    const vText = isPlainObject(v)
      ? `{${Object.keys(v).length}}`
      : Array.isArray(v)
        ? `[${v.length}]`
        : singleLinePreview(v, 30);
    const piece = `${k}: ${vText}`;
    if (len + piece.length > maxLen && parts.length > 0) { parts.push('…'); break; }
    parts.push(piece);
    len += piece.length + 2;
  }
  if (parts.length < entries.length && parts[parts.length - 1] !== '…') parts.push('…');
  return `{${parts.join(', ')}}`;
}

function formatJsonPath(segments: (string | number)[]): string {
  if (!segments.length) return '$';
  let path = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') path += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}

function formatCopyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function recordBadge(row: unknown): string | undefined {
  if (!isPlainObject(row)) return undefined;
  for (const key of ['id', 'key', 'name', 'title', 'slug', 'type']) {
    const got = ownGet(row, key);
    if (got.present && (typeof got.value === 'string' || typeof got.value === 'number')) {
      const text = String(got.value).trim();
      if (text) return text.length > 36 ? text.slice(0, 36) + '…' : text;
    }
  }
  return undefined;
}

function isTabularCandidate(payload: StructuredPayload): boolean {
  if (payload.kind !== 'value' || !Array.isArray(payload.value) || !payload.value.length) return false;
  if (payload.format === 'jsonl' || payload.format === 'ndjson') {
    const sample = payload.value.slice(0, 20);
    return sample.some(item => isPlainObject(item));
  }
  if (payload.value.length < 2) return false;
  const sample = payload.value.slice(0, 20);
  const objects = sample.filter(item => isPlainObject(item)).length;
  return objects >= Math.ceil(sample.length / 2);
}

function discoverColumns(rows: unknown[]): { columns: string[]; hasScalarFallback: boolean } {
  const seen = new Set<string>();
  const columns: string[] = [];
  let hasScalarFallback = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isPlainObject(row)) {
      hasScalarFallback = true;
      if (columns.length >= MAX_COLUMNS) return { columns, hasScalarFallback };
      continue;
    }
    if (columns.length >= MAX_COLUMNS) continue;
    const keys = Object.keys(row);
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!;
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
      if (columns.length >= MAX_COLUMNS) {
        if (hasScalarFallback) return { columns, hasScalarFallback };
        break;
      }
    }
  }
  return { columns, hasScalarFallback };
}

function valueMatchesQuery(value: unknown, lowerQuery: string, keyName?: string): boolean {
  if (!lowerQuery) return true;
  if (keyName !== undefined && keyName.toLowerCase().includes(lowerQuery)) return true;
  if (value === null) return 'null'.includes(lowerQuery);
  if (value === undefined) return false;
  if (typeof value !== 'object') return String(value).toLowerCase().includes(lowerQuery);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (valueMatchesQuery(value[i], lowerQuery)) return true;
    }
    return false;
  }
  const entries = ownEntries(value as Record<string, unknown>);
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i]!;
    if (valueMatchesQuery(v, lowerQuery, k)) return true;
  }
  return false;
}

function xmlMatchesQuery(node: XmlTreeNode | string, lowerQuery: string): boolean {
  if (!lowerQuery) return true;
  if (typeof node === 'string') return node.toLowerCase().includes(lowerQuery);
  if (node.tag.toLowerCase().includes(lowerQuery)) return true;
  if (node.attrs) {
    for (const [k, v] of node.attrs) {
      if (k.toLowerCase().includes(lowerQuery) || v.toLowerCase().includes(lowerQuery)) return true;
    }
  }
  for (const child of node.children) {
    if (xmlMatchesQuery(child, lowerQuery)) return true;
  }
  return false;
}

function injectStyles(theme: PreviewTheme) {
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

function createTreeRenderer(options: {
  rootData: StructuredPayload;
  defaultOpenDepth: number;
  maxAutoOpenKeys: number;
  onStatus?: (matches: number) => void;
}) {
  const { rootData, defaultOpenDepth, maxAutoOpenKeys, onStatus } = options;

  function renderValueTree(container: HTMLElement, value: unknown, lowerQuery: string, forceExpandAll: boolean | null): { matches: number; expandedCount: number } {
    container.replaceChildren();
    let matches = 0;
    let expandedCount = 0;
    const isRootArrayLarge = Array.isArray(value) && value.length > 10;
    const isRootObjLarge = isPlainObject(value) && Object.keys(value).length > maxAutoOpenKeys;

    function buildPrimitive(val: unknown): HTMLElement {
      if (val === null) return el('span', 'st-null', 'null');
      if (val === undefined) return el('span', 'st-null', 'undefined');
      if (typeof val === 'boolean') return el('span', 'st-bool', String(val));
      if (typeof val === 'number') return el('span', 'st-num', String(val));
      const str = String(val);
      if (str.length > LONG_STRING_THRESHOLD || str.includes('\n')) {
        const wrap = el('span');
        const single = str.replace(/\r?\n/g, '↵');
        const compact = el('span', 'st-str');
        const shown = JSON.stringify(single.length > 120 ? single.slice(0, 120) + '…' : single);
        matches += appendHighlighted(compact, shown, lowerQuery);
        const toggle = el('button', 'st-pill', '展开');
        toggle.type = 'button';
        let expanded = Boolean(lowerQuery && str.toLowerCase().includes(lowerQuery) && str.includes('\n'));
        let block: HTMLPreElement | undefined;
        const sync = () => {
          toggle.textContent = expanded ? '收起' : '展开';
          if (expanded) {
            if (!block) {
              block = el('pre', 'st-str-block');
              appendHighlighted(block, str, lowerQuery);
            }
            compact.hidden = true;
            if (!block.isConnected) wrap.append(block);
          } else {
            compact.hidden = false;
            block?.remove();
          }
        };
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          expanded = !expanded;
          sync();
        });
        wrap.append(compact, toggle);
        if (expanded) sync();
        return wrap;
      }
      const span = el('span', 'st-str');
      matches += appendHighlighted(span, JSON.stringify(str), lowerQuery);
      return span;
    }

    function addRowActions(row: HTMLElement, pathSegments: (string | number)[], val: unknown) {
      const actions = el('span', 'st-row-actions');
      const copyVal = el('button', 'st-mini-btn', '复制值');
      copyVal.type = 'button';
      copyVal.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyText(formatCopyValue(val)).then(ok => {
          if (!ok) return;
          copyVal.textContent = '已复制';
          copyVal.classList.add('is-ok');
          setTimeout(() => { copyVal.textContent = '复制值'; copyVal.classList.remove('is-ok'); }, 1200);
        });
      });
      const copyPath = el('button', 'st-mini-btn', '路径');
      copyPath.type = 'button';
      copyPath.title = formatJsonPath(pathSegments);
      copyPath.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyText(formatJsonPath(pathSegments)).then(ok => {
          if (!ok) return;
          copyPath.textContent = '已复制';
          copyPath.classList.add('is-ok');
          setTimeout(() => { copyPath.textContent = '路径'; copyPath.classList.remove('is-ok'); }, 1200);
        });
      });
      actions.append(copyVal, copyPath);
      row.append(actions);
    }

    function buildNode(val: unknown, key: string | number | undefined, depth: number, pathSegments: (string | number)[]): HTMLElement | undefined {
      const keyLabel = key === undefined ? undefined : String(key);
      if (lowerQuery && !valueMatchesQuery(val, lowerQuery, keyLabel)) return undefined;

      const isObject = typeof val === 'object' && val !== null;
      if (!isObject) {
        const node = el('div', 'st-node');
        const row = el('div', 'st-row');
        row.append(el('span', 'st-spacer'));
        const content = el('span', 'st-content');
        if (key !== undefined) {
          const kSpan = el('span', typeof key === 'number' ? 'st-idx' : 'st-key');
          matches += appendHighlighted(kSpan, String(key), lowerQuery);
          content.append(kSpan, el('span', 'st-colon', ':'));
        }
        content.append(buildPrimitive(val));
        row.append(content);
        addRowActions(row, pathSegments, val);
        node.append(row);
        return node;
      }

      const isArr = Array.isArray(val);
      const entries: [string | number, unknown][] = isArr
        ? val.map((item, idx) => [idx, item])
        : ownEntries(val as Record<string, unknown>);
      const count = entries.length;

      let shouldOpen = false;
      if (lowerQuery) {
        shouldOpen = count > 0 && expandedCount < MAX_EXPAND_ALL_NODES;
      } else if (forceExpandAll === true) {
        shouldOpen = count > 0 && expandedCount < MAX_EXPAND_ALL_NODES;
      } else if (forceExpandAll === false) {
        shouldOpen = depth === 0 && count > 0;
      } else {
        if (depth === 0) shouldOpen = count > 0;
        else if (depth < defaultOpenDepth && !isRootArrayLarge && !isRootObjLarge && count <= maxAutoOpenKeys) shouldOpen = true;
      }

      const node = el('div', 'st-node');
      const row = el('div', 'st-row st-row-summary');
      const toggle = el('button', 'st-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-label', shouldOpen ? '折叠' : '展开');
      toggle.append(svgIcon('M6 4l4 4-4 4'));
      if (count === 0) toggle.style.visibility = 'hidden';

      const content = el('span', 'st-content');
      if (key !== undefined) {
        const kSpan = el('span', typeof key === 'number' ? 'st-idx' : 'st-key');
        matches += appendHighlighted(kSpan, String(key), lowerQuery);
        content.append(kSpan, el('span', 'st-colon', ':'));
      }
      const openBrace = el('span', 'st-brace', isArr ? '[' : '{');
      const countSpan = el('span', 'st-count', String(count));
      content.append(openBrace, countSpan);

      if (count > 0) {
        const preview = el('span', 'st-inline-preview', singleLinePreview(val));
        content.append(preview);
      } else {
        content.append(el('span', 'st-brace', isArr ? ']' : '}'));
      }

      row.append(toggle, content);
      addRowActions(row, pathSegments, val);
      node.append(row);

      let childrenWrap: HTMLDivElement | undefined;
      let closingBrace: HTMLDivElement | undefined;
      let built = false;

      const setOpen = (open: boolean) => {
        if (count === 0) return;
        node.classList.toggle('is-open', open);
        toggle.setAttribute('aria-label', open ? '折叠' : '展开');
        if (open) {
          if (!built) {
            built = true;
            childrenWrap = el('div', 'st-children');
            for (let i = 0; i < entries.length; i++) {
              const [ck, cv] = entries[i]!;
              const childNode = buildNode(cv, ck, depth + 1, [...pathSegments, ck]);
              if (childNode) childrenWrap.append(childNode);
            }
            closingBrace = el('div', 'st-close-brace', isArr ? ']' : '}');
          }
          if (childrenWrap && !childrenWrap.isConnected) node.append(childrenWrap);
          if (closingBrace && !closingBrace.isConnected) node.append(closingBrace);
        } else {
          childrenWrap?.remove();
          closingBrace?.remove();
        }
      };

      row.addEventListener('click', () => {
        if (count === 0 || window.getSelection()?.toString()) return;
        setOpen(!node.classList.contains('is-open'));
      });

      if (shouldOpen) {
        expandedCount++;
        setOpen(true);
      }
      return node;
    }

    const built = buildNode(value, undefined, 0, []);
    if (built) container.append(built);
    else container.append(el('div', 'st-empty', '没有匹配的字段或内容'));
    onStatus?.(matches);
    return { matches, expandedCount };
  }

  function renderXmlTree(container: HTMLElement, nodes: (XmlTreeNode | string)[], lowerQuery: string, forceExpandAll: boolean | null): { matches: number; expandedCount: number } {
    container.replaceChildren();
    let matches = 0;
    let expandedCount = 0;

    function buildXml(item: XmlTreeNode | string, depth: number): HTMLElement | undefined {
      if (lowerQuery && !xmlMatchesQuery(item, lowerQuery)) return undefined;
      if (typeof item === 'string') {
        const node = el('div', 'st-node');
        const row = el('div', 'st-row');
        row.append(el('span', 'st-spacer'));
        const span = el('span', 'st-str');
        matches += appendHighlighted(span, item, lowerQuery);
        row.append(span);
        node.append(row);
        return node;
      }

      const hasChildren = item.children.length > 0;
      const singleText = item.children.length === 1 && typeof item.children[0] === 'string' ? item.children[0] : undefined;
      let shouldOpen = false;
      if (lowerQuery) shouldOpen = hasChildren && singleText === undefined && expandedCount < MAX_EXPAND_ALL_NODES;
      else if (forceExpandAll === true) shouldOpen = hasChildren && singleText === undefined && expandedCount < MAX_EXPAND_ALL_NODES;
      else if (forceExpandAll === false) shouldOpen = depth === 0 && hasChildren && singleText === undefined;
      else shouldOpen = depth < 2 && hasChildren && singleText === undefined;

      const node = el('div', 'st-node');
      const row = el('div', 'st-row st-row-summary');
      const toggle = el('button', 'st-toggle');
      toggle.type = 'button';
      toggle.append(svgIcon('M6 4l4 4-4 4'));
      if (!hasChildren || singleText !== undefined) toggle.style.visibility = 'hidden';

      const content = el('span', 'st-content');
      content.append(el('span', 'st-brace', '<'));
      const tagSpan = el('span', 'st-tag');
      matches += appendHighlighted(tagSpan, item.tag, lowerQuery);
      content.append(tagSpan);

      if (item.attrs) {
        for (const [ak, av] of item.attrs) {
          content.append(document.createTextNode(' '));
          const nameSpan = el('span', 'st-attr-name');
          matches += appendHighlighted(nameSpan, ak, lowerQuery);
          content.append(nameSpan, el('span', 'st-brace', '='));
          const valSpan = el('span', 'st-attr-val');
          matches += appendHighlighted(valSpan, JSON.stringify(av), lowerQuery);
          content.append(valSpan);
        }
      }

      if (!hasChildren) {
        content.append(el('span', 'st-brace', ' />'));
      } else if (singleText !== undefined) {
        content.append(el('span', 'st-brace', '>'));
        const textSpan = el('span', 'st-str');
        matches += appendHighlighted(textSpan, singleText, lowerQuery);
        content.append(textSpan, el('span', 'st-brace', `</${item.tag}>`));
      } else {
        content.append(el('span', 'st-brace', '>'));
        content.append(el('span', 'st-count', String(item.children.length)));
        content.append(el('span', 'st-inline-preview', `… </${item.tag}>`));
      }

      row.append(toggle, content);
      node.append(row);

      let childrenWrap: HTMLDivElement | undefined;
      let closingTag: HTMLDivElement | undefined;
      let built = false;

      const setOpen = (open: boolean) => {
        if (!hasChildren || singleText !== undefined) return;
        node.classList.toggle('is-open', open);
        if (open) {
          if (!built) {
            built = true;
            childrenWrap = el('div', 'st-children');
            for (const child of item.children) {
              const childEl = buildXml(child, depth + 1);
              if (childEl) childrenWrap.append(childEl);
            }
            closingTag = el('div', 'st-close-brace');
            closingTag.append(el('span', 'st-brace', '</'), el('span', 'st-tag', item.tag), el('span', 'st-brace', '>'));
          }
          if (childrenWrap && !childrenWrap.isConnected) node.append(childrenWrap);
          if (closingTag && !closingTag.isConnected) node.append(closingTag);
        } else {
          childrenWrap?.remove();
          closingTag?.remove();
        }
      };

      if (hasChildren && singleText === undefined) {
        row.addEventListener('click', () => {
          if (window.getSelection()?.toString()) return;
          setOpen(!node.classList.contains('is-open'));
        });
      }
      if (shouldOpen) {
        expandedCount++;
        setOpen(true);
      }
      return node;
    }

    let count = 0;
    for (const rootNode of nodes) {
      const elNode = buildXml(rootNode, 0);
      if (elNode) { container.append(elNode); count++; }
    }
    if (!count) container.append(el('div', 'st-empty', '没有匹配的节点或内容'));
    onStatus?.(matches);
    return { matches, expandedCount };
  }

  return {
    render(container: HTMLElement, lowerQuery: string, forceExpandAll: boolean | null) {
      if (rootData.kind === 'xml') return renderXmlTree(container, rootData.xml ?? [], lowerQuery, forceExpandAll);
      return renderValueTree(container, rootData.value, lowerQuery, forceExpandAll);
    },
  };
}

function renderCellContent(td: HTMLTableCellElement, value: unknown, present: boolean, lowerQuery: string): void {
  if (!present) {
    td.append(el('span', 'st-cell-empty', '—'));
    return;
  }
  if (value === null) {
    td.classList.add('st-cell-mono');
    const span = el('span', 'st-null', 'null');
    if (lowerQuery) appendHighlighted(span, 'null', lowerQuery);
    td.append(span);
    return;
  }
  if (typeof value === 'boolean') {
    td.classList.add('st-cell-mono');
    const span = el('span', 'st-bool');
    appendHighlighted(span, String(value), lowerQuery);
    td.append(span);
    return;
  }
  if (typeof value === 'number') {
    td.classList.add('st-cell-mono');
    const span = el('span', 'st-num');
    appendHighlighted(span, String(value), lowerQuery);
    td.append(span);
    return;
  }
  if (typeof value === 'string') {
    const compact = value.replace(/\r?\n/g, ' ↵ ');
    const clipped = compact.length > 180 ? compact.slice(0, 180) + '…' : compact;
    td.title = value.length > 400 ? value.slice(0, 400) + '…' : value;
    appendHighlighted(td, clipped, lowerQuery);
    return;
  }
  const summary = singleLinePreview(value, 72);
  const span = el('span', 'st-cell-summary');
  appendHighlighted(span, summary, lowerQuery);
  td.title = summary;
  td.append(span);
}

function formatSourceText(payload: StructuredPayload): string {
  if (payload.source !== undefined) return payload.source;
  if ((payload.format === 'jsonl' || payload.format === 'ndjson') && Array.isArray(payload.value)) {
    return payload.value.map(item => JSON.stringify(item, null, 2)).join('\n\n');
  }
  try { return JSON.stringify(payload.value, null, 2); } catch { return String(payload.value); }
}

function renderJsonHighlightedLine(target: HTMLElement, line: string, lowerQuery: string): void {
  if (lowerQuery) {
    appendHighlighted(target, line, lowerQuery);
    return;
  }
  const tokenRegex = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  for (const match of line.matchAll(tokenRegex)) {
    const index = match.index ?? 0;
    if (index > last) target.append(document.createTextNode(line.slice(last, index)));
    const [, str, colon, bool, nil, num] = match;
    if (str !== undefined) {
      target.append(el('span', colon ? 'st-key' : 'st-str', str));
      if (colon) target.append(document.createTextNode(colon));
    } else if (bool !== undefined) {
      target.append(el('span', 'st-bool', bool));
    } else if (nil !== undefined) {
      target.append(el('span', 'st-null', nil));
    } else if (num !== undefined) {
      target.append(el('span', 'st-num', num));
    }
    last = index + match[0].length;
  }
  if (last < line.length) target.append(document.createTextNode(line.slice(last)));
}

function main() {
  const input = document.getElementById('riffet-preview-data');
  if (!input?.textContent) throw new Error('缺少结构化预览数据');
  const payload = JSON.parse(input.textContent) as StructuredPayload;
  input.remove();

  injectStyles(payload.theme);
  const host = document.getElementById('preview') ?? document.body;
  const root = el('div');
  root.id = 'st-root';
  host.replaceWith(root);

  const tabular = isTabularCandidate(payload);
  const isJsonLines = payload.format === 'jsonl' || payload.format === 'ndjson';
  let mode: ViewMode = tabular && isJsonLines ? 'table' : 'tree';
  let query = '';
  let expandState: boolean | null = null;
  let selectedRowIndex: number | undefined = tabular && Array.isArray(payload.value) && payload.value.length > 0 ? 0 : undefined;
  let activeObserver: IntersectionObserver | undefined;
  let activeCleanup: (() => void) | undefined;
  let stepCurrentRow: ((delta: -1 | 1) => void) | undefined;
  let closeCurrentInspector: (() => void) | undefined;
  let searchTimer: number | undefined;

  // Toolbar
  const toolbar = el('div', 'st-toolbar');
  const searchWrap = el('div', 'st-search-wrap');
  const searchIcon = svgIcon(ICONS.search);
  searchIcon.classList.add('st-search-icon');
  const searchInput = el('input', 'st-search');
  searchInput.type = 'search';
  searchInput.placeholder = '筛选… (⌘F)';
  searchInput.setAttribute('aria-label', '筛选字段或值');
  const searchMeta = el('span', 'st-search-meta');
  const searchClear = el('button', 'st-search-clear');
  searchClear.type = 'button';
  searchClear.hidden = true;
  searchClear.setAttribute('aria-label', '清除筛选');
  searchClear.append(svgIcon(ICONS.close));
  searchWrap.append(searchIcon, searchInput, searchMeta, searchClear);

  const seg = el('div', 'st-seg');
  seg.setAttribute('role', 'tablist');
  const modeButtons = new Map<ViewMode, HTMLButtonElement>();
  const modes: [ViewMode, string][] = tabular ? [['table', '表格'], ['tree', '树'], ['source', '源码']] : [['tree', '树'], ['source', '源码']];
  for (const [m, label] of modes) {
    const btn = el('button', undefined, label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => {
      if (mode === m) return;
      mode = m;
      renderView();
    });
    modeButtons.set(m, btn);
    seg.append(btn);
  }

  const actions = el('div', 'st-actions');
  const expandBtn = el('button', 'st-btn');
  expandBtn.type = 'button';
  expandBtn.title = '全部展开';
  expandBtn.setAttribute('aria-label', '全部展开');
  expandBtn.append(svgIcon(ICONS.expandAll));
  expandBtn.addEventListener('click', () => { expandState = true; renderView(); });

  const collapseBtn = el('button', 'st-btn');
  collapseBtn.type = 'button';
  collapseBtn.title = '全部折叠';
  collapseBtn.setAttribute('aria-label', '全部折叠');
  collapseBtn.append(svgIcon(ICONS.collapseAll));
  collapseBtn.addEventListener('click', () => { expandState = false; renderView(); });

  const copyAllBtn = el('button', 'st-btn');
  copyAllBtn.type = 'button';
  copyAllBtn.title = '复制全部内容';
  copyAllBtn.setAttribute('aria-label', '复制全部内容');
  const copyAllIcon = svgIcon(ICONS.copy);
  copyAllBtn.append(copyAllIcon);
  copyAllBtn.addEventListener('click', () => {
    void copyText(formatSourceText(payload)).then(ok => {
      if (!ok) return;
      copyAllBtn.classList.add('is-ok');
      copyAllBtn.replaceChildren(svgIcon(ICONS.check));
      setTimeout(() => {
        copyAllBtn.classList.remove('is-ok');
        copyAllBtn.replaceChildren(svgIcon(ICONS.copy));
      }, 1200);
    });
  });

  actions.append(expandBtn, collapseBtn, copyAllBtn);
  toolbar.append(searchWrap, seg, actions);

  const notice = el('div', 'st-notice');
  const noticeText = el('span');
  const noticeStats = el('span');
  notice.append(noticeText, noticeStats);
  const clippedLabel = payload.totalLines ? `共 ${payload.totalLines} 条，仅展示前一部分` : '内容较多，仅展示前一部分';
  const syncNotice = (extra?: string) => {
    if (extra) {
      notice.hidden = false;
      noticeText.textContent = extra;
    } else if (payload.clipped) {
      notice.hidden = false;
      noticeText.textContent = clippedLabel;
    } else {
      notice.hidden = true;
    }
  };
  syncNotice();

  const stage = el('div', 'st-stage');
  root.append(toolbar, notice, stage);

  const treeRenderer = createTreeRenderer({
    rootData: payload,
    defaultOpenDepth: 2,
    maxAutoOpenKeys: 12,
  });

  function syncToolbar() {
    for (const [m, btn] of modeButtons) btn.setAttribute('aria-selected', String(m === mode));
    expandBtn.hidden = mode !== 'tree';
    collapseBtn.hidden = mode !== 'tree';
    searchClear.hidden = !query;
  }

  function renderTableView() {
    const rows = (payload.value as unknown[]) ?? [];
    const { columns, hasScalarFallback } = discoverColumns(rows);
    const lowerQuery = query.trim().toLowerCase();
    const filteredIndices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!lowerQuery || valueMatchesQuery(rows[i], lowerQuery)) filteredIndices.push(i);
    }
    if (selectedRowIndex !== undefined && !filteredIndices.includes(selectedRowIndex)) {
      selectedRowIndex = filteredIndices[0];
    }

    searchMeta.textContent = lowerQuery ? `${filteredIndices.length}/${rows.length}` : `${rows.length} 条`;

    const tablePane = el('div', 'st-table-pane');
    const resizer = el('div', 'st-resizer');
    const inspector = el('div', 'st-inspector');
    resizer.hidden = true;
    inspector.hidden = true;

    const inspectorHead = el('div', 'st-inspector-head');
    const inspectorTitle = el('div', 'st-inspector-title');
    const inspectorLabel = el('span');
    const inspectorBadge = el('span', 'st-inspector-badge');
    inspectorTitle.append(inspectorLabel, inspectorBadge);

    const prevBtn = el('button', 'st-btn');
    prevBtn.type = 'button'; prevBtn.title = '上一条 (↑)'; prevBtn.setAttribute('aria-label', '上一条');
    prevBtn.append(svgIcon(ICONS.up));
    const nextBtn = el('button', 'st-btn');
    nextBtn.type = 'button'; nextBtn.title = '下一条 (↓)'; nextBtn.setAttribute('aria-label', '下一条');
    nextBtn.append(svgIcon(ICONS.down));
    const copyRowBtn = el('button', 'st-btn', '复制');
    copyRowBtn.type = 'button'; copyRowBtn.title = '复制该条 JSON';
    const closeInspectorBtn = el('button', 'st-btn');
    closeInspectorBtn.type = 'button'; closeInspectorBtn.title = '关闭 (Esc)'; closeInspectorBtn.setAttribute('aria-label', '关闭详情');
    closeInspectorBtn.append(svgIcon(ICONS.close));
    inspectorHead.append(inspectorTitle, prevBtn, nextBtn, copyRowBtn, closeInspectorBtn);

    const inspectorBody = el('div', 'st-tree-scroll');
    inspector.append(inspectorHead, inspectorBody);

    const rowElements = new Map<number, HTMLTableRowElement>();

    const updateInspector = () => {
      for (const [idx, tr] of rowElements) tr.classList.toggle('is-selected', idx === selectedRowIndex);
      if (selectedRowIndex === undefined || selectedRowIndex < 0 || selectedRowIndex >= rows.length) {
        resizer.hidden = true;
        inspector.hidden = true;
        return;
      }
      const pos = filteredIndices.indexOf(selectedRowIndex);
      const record = rows[selectedRowIndex];
      resizer.hidden = false;
      inspector.hidden = false;
      inspectorLabel.textContent = `第 ${selectedRowIndex + 1} 条`;
      inspectorBadge.textContent = recordBadge(record) ?? '';
      prevBtn.disabled = pos <= 0;
      nextBtn.disabled = pos === -1 || pos >= filteredIndices.length - 1;

      const rowRenderer = createTreeRenderer({
        rootData: { ...payload, kind: 'value', value: record },
        defaultOpenDepth: 2,
        maxAutoOpenKeys: 16,
      });
      rowRenderer.render(inspectorBody, lowerQuery, null);
      inspectorBody.scrollTop = 0;

      const selectedTr = rowElements.get(selectedRowIndex);
      selectedTr?.scrollIntoView({ block: 'nearest' });
    };

    const stepInspector = (delta: -1 | 1) => {
      if (!filteredIndices.length) return;
      if (selectedRowIndex === undefined) {
        selectedRowIndex = filteredIndices[0];
      } else {
        const pos = filteredIndices.indexOf(selectedRowIndex);
        const nextPos = pos === -1 ? 0 : Math.max(0, Math.min(filteredIndices.length - 1, pos + delta));
        selectedRowIndex = filteredIndices[nextPos];
      }
      updateInspector();
    };

    prevBtn.addEventListener('click', () => stepInspector(-1));
    nextBtn.addEventListener('click', () => stepInspector(1));
    closeInspectorBtn.addEventListener('click', () => { selectedRowIndex = undefined; updateInspector(); });
    copyRowBtn.addEventListener('click', () => {
      if (selectedRowIndex === undefined) return;
      void copyText(formatCopyValue(rows[selectedRowIndex])).then(ok => {
        if (!ok) return;
        copyRowBtn.textContent = '已复制';
        copyRowBtn.classList.add('is-ok');
        setTimeout(() => { copyRowBtn.textContent = '复制'; copyRowBtn.classList.remove('is-ok'); }, 1200);
      });
    });

    // Drag resize between table and inspector
    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      try { resizer.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      const startY = event.clientY;
      const startHeight = inspector.getBoundingClientRect().height;
      const stageHeight = stage.getBoundingClientRect().height;
      const onMove = (move: PointerEvent) => {
        const next = Math.max(120, Math.min(stageHeight * 0.78, startHeight - (move.clientY - startY)));
        inspector.style.height = `${next}px`;
      };
      const cleanupDrag = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanupDrag);
        window.removeEventListener('pointercancel', cleanupDrag);
        try { if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        activeCleanup = undefined;
      };
      activeCleanup?.();
      activeCleanup = cleanupDrag;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', cleanupDrag);
      window.addEventListener('pointercancel', cleanupDrag);
    });

    if (!filteredIndices.length) {
      tablePane.append(el('div', 'st-empty', '没有匹配的记录'));
      stage.append(tablePane);
      return;
    }

    const table = el('table', 'st-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', 'st-col-num', '#'));
    for (const col of columns) headRow.append(el('th', undefined, col));
    if (hasScalarFallback) headRow.append(el('th', undefined, '(value)'));
    thead.append(headRow);
    const tbody = el('tbody');
    table.append(thead, tbody);

    const sentinel = el('div', 'st-sentinel');
    tablePane.append(table, sentinel);
    stage.append(tablePane, resizer, inspector);

    let renderedCursor = 0;
    const appendBatch = () => {
      if (renderedCursor >= filteredIndices.length) return;
      const frag = document.createDocumentFragment();
      const limit = Math.min(filteredIndices.length, renderedCursor + TABLE_PAGE);
      for (; renderedCursor < limit; renderedCursor++) {
        const rowIndex = filteredIndices[renderedCursor]!;
        const row = rows[rowIndex];
        const tr = el('tr');
        if (rowIndex === selectedRowIndex) tr.classList.add('is-selected');
        tr.append(el('td', 'st-col-num', String(rowIndex + 1)));

        if (isPlainObject(row)) {
          for (const col of columns) {
            const td = el('td');
            const got = ownGet(row, col);
            renderCellContent(td, got.value, got.present, lowerQuery);
            tr.append(td);
          }
          if (hasScalarFallback) {
            const td = el('td');
            td.append(el('span', 'st-cell-empty', '—'));
            tr.append(td);
          }
        } else {
          for (let c = 0; c < columns.length; c++) {
            const td = el('td');
            td.append(el('span', 'st-cell-empty', '—'));
            tr.append(td);
          }
          if (hasScalarFallback) {
            const td = el('td');
            renderCellContent(td, row, true, lowerQuery);
            tr.append(td);
          }
        }

        tr.addEventListener('click', () => {
          selectedRowIndex = selectedRowIndex === rowIndex ? undefined : rowIndex;
          updateInspector();
        });
        rowElements.set(rowIndex, tr);
        frag.append(tr);
      }
      tbody.append(frag);
    };

    appendBatch();
    if (selectedRowIndex !== undefined) {
      while (renderedCursor < filteredIndices.length && !rowElements.has(selectedRowIndex)) appendBatch();
      updateInspector();
    }

    if (renderedCursor < filteredIndices.length) {
      activeObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          appendBatch();
          if (renderedCursor >= filteredIndices.length) activeObserver?.disconnect();
        }
      }, { root: tablePane, rootMargin: '300px' });
      activeObserver.observe(sentinel);
    }

    stepCurrentRow = stepInspector;
    closeCurrentInspector = () => {
      if (selectedRowIndex === undefined) return;
      selectedRowIndex = undefined;
      updateInspector();
    };
  }

  function renderTreeView() {
    const scroll = el('div', 'st-tree-scroll');
    const lowerQuery = query.trim().toLowerCase();
    const result = treeRenderer.render(scroll, lowerQuery, expandState);
    searchMeta.textContent = lowerQuery ? `${result.matches} 处` : '';
    syncNotice(expandState === true && result.expandedCount >= MAX_EXPAND_ALL_NODES ? `节点较多，仅展开前 ${MAX_EXPAND_ALL_NODES} 个节点` : undefined);
    stage.append(scroll);
  }

  function renderSourceView() {
    const scroll = el('div', 'st-source-scroll');
    const text = formatSourceText(payload);
    const lines = text.split(/\r?\n/);
    const lowerQuery = query.trim().toLowerCase();
    const isJsonStyle = payload.source === undefined;

    if (payload.sourceClipped) {
      syncNotice(payload.clipped ? `${clippedLabel}；源码仅展示前 512 KB` : '源码仅展示前 512 KB');
    }

    const visibleLines: { num: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!lowerQuery || line.toLowerCase().includes(lowerQuery)) {
        visibleLines.push({ num: i + 1, text: line });
      }
    }
    searchMeta.textContent = lowerQuery ? `${visibleLines.length} 行` : `${lines.length} 行`;

    const sentinel = el('div', 'st-sentinel');
    stage.append(scroll);
    scroll.append(sentinel);

    let cursor = 0;
    const appendBatch = () => {
      if (cursor >= visibleLines.length) return;
      const frag = document.createDocumentFragment();
      const limit = Math.min(visibleLines.length, cursor + SOURCE_PAGE);
      for (; cursor < limit; cursor++) {
        const entry = visibleLines[cursor]!;
        const row = el('div', 'st-src-line');
        row.append(el('span', 'st-src-num', String(entry.num)));
        const code = el('span', 'st-src-code');
        if (isJsonStyle) renderJsonHighlightedLine(code, entry.text, lowerQuery);
        else appendHighlighted(code, entry.text, lowerQuery);
        row.append(code);
        frag.append(row);
      }
      scroll.insertBefore(frag, sentinel);
    };

    appendBatch();
    if (lowerQuery && visibleLines.length === 0) {
      scroll.insertBefore(el('div', 'st-empty', '没有匹配的行'), sentinel);
    }
    if (cursor < visibleLines.length) {
      activeObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          appendBatch();
          if (cursor >= visibleLines.length) activeObserver?.disconnect();
        }
      }, { root: scroll, rootMargin: '400px' });
      activeObserver.observe(sentinel);
    }
  }

  function renderView() {
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
    }
    activeObserver?.disconnect();
    activeObserver = undefined;
    activeCleanup?.();
    activeCleanup = undefined;
    stepCurrentRow = undefined;
    closeCurrentInspector = undefined;
    stage.replaceChildren();
    syncToolbar();
    syncNotice();
    if (mode === 'table') renderTableView();
    else if (mode === 'tree') renderTreeView();
    else renderSourceView();
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    syncToolbar();
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = undefined;
      renderView();
    }, 90);
  });

  searchClear.addEventListener('click', () => {
    query = '';
    searchInput.value = '';
    searchInput.focus();
    renderView();
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (event.key === '/' && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    } else if (event.key === 'Escape') {
      if (document.activeElement === searchInput && query) {
        query = '';
        searchInput.value = '';
        renderView();
      } else if (mode === 'table' && selectedRowIndex !== undefined) {
        closeCurrentInspector?.();
      }
    } else if (mode === 'table' && document.activeElement !== searchInput && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      stepCurrentRow?.(event.key === 'ArrowDown' ? 1 : -1);
    }
  });

  renderView();
}

try {
  main();
} catch (error) {
  const failure = document.createElement('p');
  failure.style.padding = '16px';
  failure.textContent = error instanceof Error ? `预览失败：${error.message}` : '预览失败';
  document.body.replaceChildren(failure);
}
