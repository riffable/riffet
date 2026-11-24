export type PreviewTheme = { dark: boolean; foreground: string; background: string; line: string; accent: string };

export interface XmlTreeNode {
  tag: string;
  attrs?: [string, string][];
  children: (XmlTreeNode | string)[];
}

export type StructuredPayload = {
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

export type ViewMode = 'table' | 'tree' | 'source';

export const TABLE_PAGE = 150;
export const SOURCE_PAGE = 300;
export const MAX_COLUMNS = 120;
export const MAX_EXPAND_ALL_NODES = 2500;
export const LONG_STRING_THRESHOLD = 140;

const hasOwn = Object.prototype.hasOwnProperty;
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function ownEntries(object: Record<string, unknown>): [string, unknown][] {
  const keys = Object.keys(object);
  const entries: [string, unknown][] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) entries.push([key, descriptor.value]);
  }
  return entries;
}

export function ownGet(object: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
  if (!hasOwn.call(object, key)) return { present: false, value: undefined };
  return { present: true, value: Object.getOwnPropertyDescriptor(object, key)?.value };
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svgIcon(pathD: string): SVGSVGElement {
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

export const ICONS = {
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm6.5 1.5L10.8 10.8',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  copy: 'M5.5 5.5v-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z',
  check: 'M3.5 8.5l3 3 6-6.5',
  expandAll: 'M4.5 5.5L8 2.5l3.5 3M4.5 10.5L8 13.5l3.5-3',
  collapseAll: 'M4.5 2.5L8 5.5l3.5-3M4.5 13.5L8 10.5l3.5 3',
  up: 'M4 10l4-4 4 4',
  down: 'M4 6l4 4 4-4',
};

export async function copyText(text: string): Promise<boolean> {
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

export function appendHighlighted(target: HTMLElement, text: string, lowerQuery: string): number {
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

export function singleLinePreview(value: unknown, maxLen = 88): string {
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

export function formatJsonPath(segments: (string | number)[]): string {
  if (!segments.length) return '$';
  let path = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') path += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}

export function formatCopyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function recordBadge(row: unknown): string | undefined {
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

export function isTabularCandidate(payload: StructuredPayload): boolean {
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

export function discoverColumns(rows: unknown[]): { columns: string[]; hasScalarFallback: boolean } {
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

export function valueMatchesQuery(value: unknown, lowerQuery: string, keyName?: string): boolean {
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

export function xmlMatchesQuery(node: XmlTreeNode | string, lowerQuery: string): boolean {
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

export function renderCellContent(td: HTMLTableCellElement, value: unknown, present: boolean, lowerQuery: string): void {
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

export function formatSourceText(payload: StructuredPayload): string {
  if (payload.source !== undefined) return payload.source;
  if ((payload.format === 'jsonl' || payload.format === 'ndjson') && Array.isArray(payload.value)) {
    return payload.value.map(item => JSON.stringify(item, null, 2)).join('\n\n');
  }
  try { return JSON.stringify(payload.value, null, 2); } catch { return String(payload.value); }
}

export function renderJsonHighlightedLine(target: HTMLElement, line: string, lowerQuery: string): void {
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
