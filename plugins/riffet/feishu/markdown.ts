/*
 * Model Markdown to Feishu card elements. The text is parsed into an mdast tree (remark) and mapped
 * block by block, never patched with regexes: a fenced block gets its own element with the fence
 * closed, a table becomes a native table, a list holding code is cut around the code.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Code, List, Root, RootContent, Table } from 'mdast';

export type CardElement = Record<string, unknown>;
/** `native`: real table elements; `code`: tables as code blocks (after a table-limit error). */
export type TableMode = 'native' | 'code';
export interface RenderOptions { tables?: TableMode; single?: boolean }

const MAX_TABLE_COLUMNS = 10;
const MAX_TABLE_PAGE = 100;

const parser = unified().use(remarkParse).use(remarkGfm);
const parse = (source: string): Root => parser.parse(source);

interface Positioned { position?: { start: { offset?: number }; end: { offset?: number } }; children?: unknown[] }
const startOf = (node: Positioned): number | undefined => node.position?.start.offset;
const endOf = (node: Positioned): number | undefined => node.position?.end.offset;

/** A URL that survives being written inside `[](...)`. */
const safeUrl = (url: string): string => url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

interface Edit { start: number; end: number; text: string }

function collectEdits(source: string, nodes: unknown[] | undefined, edits: Edit[]): void {
  for (const raw of nodes ?? []) {
    const node = raw as Positioned & { type: string; url?: string; title?: string | null; alt?: string | null; children?: unknown[] };
    const start = startOf(node);
    const end = endOf(node);
    if (start === undefined || end === undefined) continue;
    if (node.type === 'image') {
      // Feishu resolves an image in card Markdown by `img_key`; a URL or a file path is an invalid key
      // that fails the whole card, so a remote image degrades to a link and a local path disappears.
      const url = node.url ?? '';
      edits.push({ start, end, text: /^https?:\/\//i.test(url) ? `[${node.alt || '图片'}](${safeUrl(url)})` : '' });
    } else if (node.type === 'link' && node.title) {
      const children = (node.children ?? []) as Positioned[];
      const first = children[0] ? startOf(children[0]) : undefined;
      const last = children.length ? endOf(children[children.length - 1]!) : undefined;
      const nested: Edit[] = [];
      collectEdits(source, node.children, nested);
      let label = first !== undefined && last !== undefined ? applyEdits(source, first, last, nested) : (node.url ?? '');
      if (!label.trim()) label = node.url ?? '';
      edits.push({ start, end, text: `[${label}](${safeUrl(node.url ?? '')})` });
    } else {
      collectEdits(source, node.children, edits);
    }
  }
}

function applyEdits(source: string, start: number, end: number, edits: Edit[]): string {
  let out = '';
  let position = start;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < position) continue;
    out += source.slice(position, edit.start) + edit.text;
    position = edit.end;
  }
  return out + source.slice(position, end);
}

/** Images dropped or turned into links, link titles removed: the part that needs the tree, done once up front. */
function cleanInline(source: string): string {
  if (!/!\[|\]\([^)\n]*\s["'(]/.test(source)) return source;
  const edits: Edit[] = [];
  collectEdits(source, parse(source).children, edits);
  return edits.length ? applyEdits(source, 0, source.length, edits) : source;
}

function fence(value: string, lang?: string | null): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  const tag = lang && /^[\w+#.-]{1,30}$/.test(lang) ? lang : '';
  return `${ticks}${tag}\n${value.replace(/\n+$/, '')}\n${ticks}`;
}

/** `<font>` is an inline span: one that crosses a line break leaks its closing tag as text. */
function keepFontOnOneLine(text: string): string {
  if (!text.includes('<font')) return text;
  return text.replace(/(<font\b[^>]*>)([\s\S]*?)<\/font>/gi, (whole, open: string, inner: string) => {
    if (!inner.includes('\n')) return whole;
    return inner.split('\n').map(line => (line.trim() ? `${open}${line}</font>` : line)).join('\n');
  });
}

const markdown = (content: string): CardElement => ({ tag: 'markdown', content: keepFontOnOneLine(content) });

function descendantsOfType<T extends RootContent>(node: unknown, type: string, found: T[] = []): T[] {
  for (const child of ((node as Positioned).children ?? []) as Array<Positioned & { type: string }>) {
    if (child.type === type) found.push(child as unknown as T);
    else descendantsOfType(child, type, found);
  }
  return found;
}

/** Strips the indentation a list item put in front of text that continues after a lifted-out code block. */
function dedent(text: string): string {
  const lines = text.split('\n');
  const indents = lines.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length);
  const cut = Math.min(...indents, Infinity);
  return Number.isFinite(cut) && cut > 0 ? lines.map(line => line.slice(cut)).join('\n') : text;
}

/** A cell's own content: the node itself also spans the pipe that opens it. */
function cellText(source: string, cell: Positioned): string {
  const children = (cell.children ?? []) as Positioned[];
  const start = children.length ? startOf(children[0]!) : undefined;
  const end = children.length ? endOf(children[children.length - 1]!) : undefined;
  return start === undefined || end === undefined ? '' : source.slice(start, end).trim().replace(/\\\|/g, '|');
}

function nativeTable(source: string, table: Table): CardElement | undefined {
  const rows = table.children;
  const columnCount = Math.max(...rows.map(row => row.children.length));
  if (columnCount > MAX_TABLE_COLUMNS || columnCount < 1) return undefined;
  const header = rows[0]!;
  const bodyRows = rows.slice(1);
  return {
    tag: 'table',
    page_size: Math.min(Math.max(bodyRows.length, 1), MAX_TABLE_PAGE),
    row_height: 'auto',
    header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', text_color: 'default', bold: true, lines: 2 },
    columns: Array.from({ length: columnCount }, (_, index) => ({
      name: `col_${index}`,
      display_name: cellText(source, header.children[index] ?? {}) || `列${index + 1}`,
      data_type: 'lark_md',
      horizontal_align: table.align?.[index] ?? 'left',
    })),
    rows: bodyRows.map(row => Object.fromEntries(Array.from({ length: columnCount }, (_, index) => [`col_${index}`, cellText(source, row.children[index] ?? {})]))),
  };
}

type Piece =
  | { type: 'text'; text: string; list: boolean }
  | { type: 'element'; element: CardElement }
  | { type: 'code'; text: string };

function pieces(source: string, tables: TableMode): Piece[] {
  const out: Piece[] = [];
  const slice = (node: Positioned): string => source.slice(startOf(node) ?? 0, endOf(node) ?? 0);
  const text = (value: string, list: boolean): void => { if (value.trim()) out.push({ type: 'text', text: value.trim(), list }); };
  const code = (node: Code): void => { if (node.value.trim()) out.push({ type: 'code', text: fence(node.value, node.lang) }); };

  for (const node of parse(source).children) {
    if (node.type === 'code') code(node);
    else if (node.type === 'table') {
      const native = tables === 'native' ? nativeTable(source, node) : undefined;
      if (native) out.push({ type: 'element', element: native });
      else out.push({ type: 'code', text: fence(slice(node)) });
    } else if (node.type === 'list' && descendantsOfType<Code>(node, 'code').length) {
      // Fenced code nested in a list item is dropped by the card renderer, so it is lifted to the top level.
      let position = startOf(node) ?? 0;
      for (const inner of descendantsOfType<Code>(node as List, 'code')) {
        text(dedent(source.slice(position, startOf(inner) ?? position)), true);
        code(inner);
        position = endOf(inner) ?? position;
      }
      text(dedent(source.slice(position, endOf(node) ?? position)), true);
    } else text(slice(node), node.type === 'list');
  }
  return out;
}

export function renderMarkdown(source: string, options: RenderOptions = {}): CardElement[] {
  const cleaned = cleanInline(source);
  if (!cleaned.trim()) return [];
  if (options.single) {
    // One element: tables are code blocks, since a native table cannot live inside Markdown text.
    const texts = pieces(cleaned, 'code').map(piece => (piece.type === 'element' ? '' : piece.text)).filter(Boolean);
    return [markdown(texts.join('\n\n'))];
  }
  const list = pieces(cleaned, options.tables ?? 'native');

  const elements: CardElement[] = [];
  let buffer: string[] = [];
  let previousWasParagraph = false;
  const flush = (): void => {
    if (buffer.length) elements.push(markdown(buffer.join('\n\n')));
    buffer = [];
    previousWasParagraph = false;
  };
  for (const piece of list) {
    if (piece.type === 'text') {
      // A list right after a paragraph is cut into its own element so the card renderer starts it cleanly.
      if (piece.list && previousWasParagraph) flush();
      buffer.push(piece.text);
      previousWasParagraph = !piece.list;
    } else {
      flush();
      elements.push(piece.type === 'code' ? markdown(piece.text) : piece.element);
    }
  }
  flush();
  return elements;
}

/** The part of the table-limit count a rendering uses: native tables, which the card caps at five. */
export const countTables = (elements: CardElement[]): number => elements.filter(element => element.tag === 'table').length;
