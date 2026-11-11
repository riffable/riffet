import { parseAllDocuments } from 'yaml';
import { DOMParser, type Node as XmlNode, type Element as XmlElement } from '@xmldom/xmldom';
import { parse as parseToml } from 'smol-toml';
import { escapeHtml } from './document.js';
import { decodePreviewText, extensionOf } from './formats.js';
import type { PreviewFragment, PreviewParseInput } from './parse.js';

const ITEMS = 20_000, DEPTH = 64;

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

function xmlTree(source: string): string {
  // No DTD/entity declarations: the preview never needs external resources or entity expansion.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('XML 预览不读取 DTD 或实体声明');
  const document = new DOMParser({ locator: false, onError(level, message) { if (level !== 'warning') throw new Error(message); } }).parseFromString(source, 'application/xml');
  let remaining = ITEMS, characters = 2_000_000;
  function visit(node: XmlNode, depth: number): string {
    if (remaining-- <= 0 || characters <= 0 || depth > DEPTH) return '';
    if (node.nodeType === 3 || node.nodeType === 4) {
      const text = (node.nodeValue ?? '').slice(0, Math.min(32_768, characters));
      characters -= text.length;
      return text.trim() ? `<div><code>${escapeHtml(text)}</code></div>` : '';
    }
    if (node.nodeType !== 1 && node.nodeType !== 9) return '';
    const content: string[] = [];
    for (let child = node.firstChild; child && remaining > 0 && characters > 0; child = child.nextSibling) content.push(visit(child, depth + 1));
    if (node.nodeType === 9) return content.join('');
    const element = node as XmlElement;
    const attributes: string[] = [];
    for (let i = 0; i < Math.min(element.attributes.length, 128) && characters > 0; i++) {
      const attribute = element.attributes.item(i)!;
      const value = attribute.value.slice(0, Math.min(4096, characters));
      characters -= value.length + attribute.name.length;
      attributes.push(`${attribute.name.slice(0, 256)}=${JSON.stringify(value)}`);
    }
    return `<details${depth < 3 ? ' open' : ''}><summary><code>${escapeHtml(element.tagName.slice(0, 512))}${attributes.length ? ' ' + escapeHtml(attributes.join(' ')) : ''}</code></summary>${content.join('')}</details>`;
  }
  return visit(document, 0) + (remaining <= 0 || characters <= 0 ? '<p class="muted">内容较多，仅显示前一部分</p>' : '');
}

export async function structuredPreview({ data, name }: PreviewParseInput): Promise<PreviewFragment> {
  const text = decodePreviewText(data);
  if (text === undefined) throw new Error('无法读取文本编码');
  const extension = extensionOf(name);
  let body: string;
  if (extension === 'xml') body = xmlTree(text);
  else {
    let value: unknown;
    if (extension === 'yaml' || extension === 'yml') {
      const documents = parseAllDocuments(text, { uniqueKeys: true });
      const values = documents.map(document => {
        if (document.errors.length) throw new Error(document.errors[0].message);
        return document.toJS({ maxAliasCount: 100 });
      });
      value = values.length === 1 ? values[0] : values;
    } else if (extension === 'toml') value = parseToml(text);
    else if (extension === 'jsonl' || extension === 'ndjson') value = text.split(/\r?\n/, ITEMS + 1).filter(line => line.trim()).slice(0, ITEMS).map(line => JSON.parse(line));
    else value = JSON.parse(text);
    body = structuredTree(value);
  }
  return { body: `<main>${body}</main>` };
}
