import { parseAllDocuments } from 'yaml';
import { DOMParser, type Node as XmlNode, type Element as XmlElement } from '@xmldom/xmldom';
import { parse as parseToml } from 'smol-toml';
import { escapeHtml } from './document.js';
import { decodePreviewText, extensionOf } from './formats.js';
import type { PreviewFragment, PreviewParseInput } from './parse.js';

const ITEMS = 20_000, DEPTH = 64, MAX_STRING_CHARS = 65_536, MAX_TOTAL_CHARS = 3_000_000, MAX_SOURCE_CHARS = 512 * 1024;

export interface XmlTreeNode {
  tag: string;
  attrs?: [string, string][];
  children: (XmlTreeNode | string)[];
}

/** Native details/summary provides expansion without ever interpolating parsed data into JS. */
export function structuredTree(value: unknown, maxCharacters = 2_000_000): string {
  let remaining = ITEMS;
  let characters = maxCharacters;
  let clipped = false;
  const seen = new WeakSet<object>();
  function primitive(value: unknown): string {
    let text = typeof value === 'string' ? JSON.stringify(value) : String(value);
    const length = Math.min(32_768, characters);
    if (text.length > length) { text = text.slice(0, length) + '…'; clipped = true; }
    characters -= Math.min(text.length, length);
    return `<code>${escapeHtml(text)}</code>`;
  }
  function visit(value: unknown, key: string, depth: number): string {
    if (remaining-- <= 0 || characters <= 0 || depth > DEPTH) { clipped = true; return ''; }
    const keyText = key.slice(0, Math.max(0, Math.min(4096, characters)));
    const title = escapeHtml(keyText);
    characters -= keyText.length;
    if (value === null || typeof value !== 'object' || value instanceof Date) return `<div>${title ? `${title}: ` : ''}${primitive(value)}</div>`;
    if (seen.has(value)) return `<div>${title}: <code>↩</code></div>`;
    seen.add(value);
    const keys = Object.keys(value);
    const rows: string[] = [];
    for (const child of keys) {
      if (remaining <= 0 || characters <= 0) { clipped = true; break; }
      rows.push(visit((value as Record<string, unknown>)[child], child, depth + 1));
    }
    return `<details${depth < 2 ? ' open' : ''}><summary>${title || (Array.isArray(value) ? '[]' : '{}')} <small>${keys.length}</small></summary>${rows.join('')}</details>`;
  }
  const body = visit(value, '', 0);
  return `${body}${clipped ? '<p class="muted">内容较多，仅显示前一部分</p>' : ''}`;
}

function sanitizeStructured(value: unknown, maxCharacters = MAX_TOTAL_CHARS): { value: unknown; clipped: boolean } {
  let remaining = ITEMS;
  let characters = maxCharacters;
  let clipped = false;
  const active = new WeakSet<object>();

  function clipString(text: string): string {
    const limit = Math.min(MAX_STRING_CHARS, Math.max(128, characters));
    if (text.length > limit) {
      clipped = true;
      characters = Math.max(0, characters - limit);
      return text.slice(0, limit) + '…';
    }
    characters = Math.max(0, characters - text.length);
    return text;
  }

  function visit(input: unknown, depth: number): unknown {
    if (remaining-- <= 0 || characters <= 0 || depth > DEPTH) { clipped = true; return undefined; }
    if (input === null || input === undefined) { characters = Math.max(0, characters - 4); return null; }
    if (typeof input === 'boolean') { characters = Math.max(0, characters - 5); return input; }
    if (typeof input === 'number') {
      characters = Math.max(0, characters - 8);
      return Number.isFinite(input) ? input : String(input);
    }
    if (typeof input === 'bigint') return clipString(input.toString());
    if (typeof input === 'string') return clipString(input);
    if (input instanceof Date) return clipString(Number.isNaN(input.getTime()) ? 'Invalid Date' : input.toISOString());
    if (typeof input !== 'object') return clipString(String(input));
    if (active.has(input)) return '[Circular ↩]';

    active.add(input);
    try {
      if (Array.isArray(input)) {
        const result: unknown[] = [];
        for (let i = 0; i < input.length; i++) {
          if (remaining <= 0 || characters <= 0) { clipped = true; break; }
          const item = visit(input[i], depth + 1);
          if (item === undefined && (remaining <= 0 || characters <= 0)) break;
          result.push(item === undefined ? null : item);
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        if (remaining <= 0 || characters <= 0) { clipped = true; break; }
        const safeKey = key.length > 4096 ? (clipped = true, key.slice(0, 4096) + '…') : key;
        characters = Math.max(0, characters - safeKey.length);
        const child = visit((input as Record<string, unknown>)[key], depth + 1);
        if (child === undefined && (remaining <= 0 || characters <= 0)) break;
        Object.defineProperty(result, safeKey, {
          value: child === undefined ? null : child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } finally {
      active.delete(input);
    }
  }

  return { value: visit(value, 0), clipped };
}

function xmlData(source: string): { nodes: (XmlTreeNode | string)[]; clipped: boolean } {
  // No DTD/entity declarations: the preview never needs external resources or entity expansion.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('XML 预览不读取 DTD 或实体声明');
  const document = new DOMParser({ locator: false, onError(level, message) { if (level !== 'warning') throw new Error(message); } }).parseFromString(source, 'application/xml');
  let remaining = ITEMS, characters = MAX_TOTAL_CHARS, clipped = false;

  function visit(node: XmlNode, depth: number): XmlTreeNode | string | undefined {
    if (remaining-- <= 0 || characters <= 0 || depth > DEPTH) { clipped = true; return undefined; }
    if (node.nodeType === 3 || node.nodeType === 4) {
      const trimmed = (node.nodeValue ?? '').trim();
      if (!trimmed) return undefined;
      const limit = Math.min(MAX_STRING_CHARS, Math.max(128, characters));
      const text = trimmed.length > limit ? (clipped = true, trimmed.slice(0, limit) + '…') : trimmed;
      characters = Math.max(0, characters - text.length);
      return text;
    }
    if (node.nodeType !== 1) return undefined;
    const element = node as XmlElement;
    const attrs: [string, string][] = [];
    for (let i = 0; i < element.attributes.length; i++) {
      if (i >= 128 || characters <= 0) { clipped = true; break; }
      const attribute = element.attributes.item(i)!;
      const name = attribute.name.slice(0, 256);
      const limit = Math.min(4096, Math.max(64, characters));
      const value = attribute.value.length > limit ? (clipped = true, attribute.value.slice(0, limit) + '…') : attribute.value;
      characters = Math.max(0, characters - name.length - value.length);
      attrs.push([name, value]);
    }
    const children: (XmlTreeNode | string)[] = [];
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (remaining <= 0 || characters <= 0) { clipped = true; break; }
      const item = visit(child, depth + 1);
      if (item !== undefined) children.push(item);
    }
    return {
      tag: element.tagName.slice(0, 512),
      ...(attrs.length ? { attrs } : {}),
      children,
    };
  }

  const nodes: (XmlTreeNode | string)[] = [];
  for (let child = document.firstChild; child; child = child.nextSibling) {
    if (remaining <= 0 || characters <= 0) { clipped = true; break; }
    const item = visit(child, 0);
    if (item !== undefined) nodes.push(item);
  }
  return { nodes, clipped };
}

function parseJsonLines(text: string): { value: unknown[]; clipped: boolean; totalLines: number } {
  const allLines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const clippedByLines = allLines.length > ITEMS;
  const slice = allLines.slice(0, ITEMS);
  if (!slice.length) return { value: [], clipped: false, totalLines: 0 };

  let validCount = 0;
  let firstError: unknown;
  const parsed = slice.map((line, index) => {
    try {
      const item = JSON.parse(line);
      validCount++;
      return item;
    } catch (error) {
      if (firstError === undefined) firstError = error;
      return {
        __riffetLine: index + 1,
        __riffetParseError: error instanceof Error ? error.message : 'Invalid JSON line',
        __riffetRawLine: line.slice(0, 4096),
      };
    }
  });
  if (validCount === 0 && firstError !== undefined) throw firstError;
  return { value: parsed, clipped: clippedByLines, totalLines: allLines.length };
}

export async function structuredPreview({ data, name, theme }: PreviewParseInput): Promise<PreviewFragment> {
  const text = decodePreviewText(data);
  if (text === undefined) throw new Error('无法读取文本编码');
  const extension = extensionOf(name) || 'json';

  if (extension === 'xml') {
    const parsed = xmlData(text);
    return {
      body: '<main id="preview"></main>',
      asset: 'structured',
      data: {
        kind: 'xml',
        format: extension,
        name,
        theme,
        clipped: parsed.clipped,
        xml: parsed.nodes,
        source: text.slice(0, MAX_SOURCE_CHARS),
        sourceClipped: text.length > MAX_SOURCE_CHARS,
      },
    };
  }

  let rawValue: unknown;
  let lineClipped = false;
  let totalLines: number | undefined;
  if (extension === 'yaml' || extension === 'yml') {
    const documents = parseAllDocuments(text, { uniqueKeys: true });
    const values = documents.map(document => {
      if (document.errors.length) throw new Error(document.errors[0].message);
      return document.toJS({ maxAliasCount: 100 });
    });
    rawValue = values.length === 1 ? values[0] : values;
  } else if (extension === 'toml') {
    rawValue = parseToml(text);
  } else if (extension === 'jsonl' || extension === 'ndjson') {
    const lines = parseJsonLines(text);
    rawValue = lines.value;
    lineClipped = lines.clipped;
    totalLines = lines.totalLines;
  } else {
    rawValue = JSON.parse(text);
  }

  const sanitized = sanitizeStructured(rawValue);
  const keepSource = extension === 'yaml' || extension === 'yml' || extension === 'toml';
  return {
    body: '<main id="preview"></main>',
    asset: 'structured',
    data: {
      kind: 'value',
      format: extension,
      name,
      theme,
      clipped: lineClipped || sanitized.clipped,
      ...(totalLines !== undefined ? { totalLines } : {}),
      value: sanitized.value,
      ...(keepSource ? { source: text.slice(0, MAX_SOURCE_CHARS), sourceClipped: text.length > MAX_SOURCE_CHARS } : {}),
    },
  };
}
