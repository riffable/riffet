/**
 * Markdown for a text block as Claude Code drew it. The TUI renders the answer's Markdown and wraps it to the pane; what
 * is on screen has lost the marks (`##`, `**`, backticks, fences, link targets) and gained line breaks. This puts back
 * what can be told apart for certain, so the draft reads like the answer it stands in for:
 *
 * - wrapped lines are joined again where the next word would not have fitted (Ink wraps at the pane's width);
 * - bullets and numbered items stay items;
 * - a line ending short inside prose is a line break the answer made, and stays one;
 * - a table becomes a Markdown table again, from either way the TUI draws one (`drawnTables`);
 * - anything else laid out by line — code, box drawing that is not a table — is kept as drawn, in a fence, since joining
 *   or reflowing it would garble it;
 * - the rest is prose, escaped so a character that was literal on screen stays literal — except a `**` pair the TUI
 *   could not parse (one touching CJK punctuation), which the answer's own renderer does read as bold.
 *
 * Headings and inline styles are not recovered: on screen they differ only in colour and weight.
 */
import { cellWidth } from '../../../adapters/cli/claude-code.js';

const ITEM = /^(\s*)([-*•]|\d+[.)])(?: |$)/;
const BOX = /^\s*[│┃┌┏├┣└┗╭╰─━]/;
const CODE_END = /[;{}]$/;
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;
/** What CJK text runs into with no space: its own characters, and the quotes and marks it is set with. */
const CLOSE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u2018\u2019\u201c\u201d\u2026\u2014]/u;

/**
 * Whether `next` continues `prev` because its first word did not fit on `prev`'s row. A word wider than the row (a run
 * of CJK with no space) is not moved down but broken where the row ends, so `prev` then reaches the edge.
 */
function wrapped(prev: string, next: string, width: number): boolean {
  const word = /^\S+/.exec(next.trimStart())?.[0] ?? '';
  if (!word) return false;
  const words = cellWidth(word);
  return words >= width - 1 ? cellWidth(prev) >= width - 1 : cellWidth(prev) + 1 + words > width;
}

/** CJK text is broken between characters, with no space taken; anything else at the space the wrap took. */
function join(prev: string, next: string): string {
  const text = next.trimStart();
  const end = prev.at(-1) ?? '', start = text[0] ?? '';
  return CLOSE.test(end) && CLOSE.test(start) && (WIDE.test(end) || WIDE.test(start)) ? prev + text : `${prev} ${text}`;
}

function escape(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/^(\s*)([#>+=])/, '$1\\$2')
    // A balanced `**…**` still on screen is bold the TUI's parser gave up on, not asterisks the answer meant.
    .replace(/\\\*\\\*(?=\S)((?:(?!\\\*\\\*).)+?)(?<=\S)\\\*\\\*/g, '**$1**');
}

/** A box table's rule: `┌──┬──┐` above the header, `├──┼──┤` between rows, `└──┴──┘` below. */
const BORDER = /^[┌├└]─[─┬┼┴]*[┐┤┘]$/;
const ROW = /^│.*│$/;
/** A line of a box table, by its first character. */
const BOX_LINE = /^[┌├└│]/;
/** Between the records of a table drawn as records. */
const RECORD_RULE = /^─{10,}$/;
const FIELD = /^(\S[^:]*?):(?: (.*))?$/;
/** Under a table cut at its row limit, in either form. */
const MORE_ROWS = /^… [\d,]+ more rows? not shown$/;

interface Table { header: string[]; rows: string[][] }

const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
const joinCell = (cell: string, more: string) => (!more ? cell : !cell ? more : join(cell, more));

/**
 * A box table from `lines[from]` (its top rule) through its bottom rule. Each cell is word-wrapped to its column and
 * centred vertically in its row, so a row's lines are joined column by column.
 */
function boxTable(lines: readonly string[], from: number): { table: Table; next: number } | undefined {
  const top = lines[from]!.trim();
  if (!top.startsWith('┌')) return undefined;
  const columns = (top.match(/┬/g)?.length ?? 0) + 1;
  const groups: string[][] = [];
  let cells: string[] | undefined, at = from + 1;
  for (; at < lines.length; at += 1) {
    const line = lines[at]!.trim();
    if (BORDER.test(line)) {
      if (cells) groups.push(cells);
      cells = undefined;
      if (line.startsWith('└')) { at += 1; break; }
      continue;
    }
    if (!ROW.test(line)) break;
    const split = line.slice(1, -1).split('│').map(cell => cell.trim());
    if (split.length !== columns) return undefined;
    cells = cells ? cells.map((cell, i) => joinCell(cell, split[i]!)) : split;
  }
  if (cells) groups.push(cells);
  if (!groups.length) return undefined;
  return { table: { header: groups[0]!, rows: groups.slice(1) }, next: at };
}

/**
 * A table the TUI drew as records because it was too wide for the pane or a cell wrapped too far: `Header: value`
 * lines, a value's wrapped lines hanging under it, records apart by a rule. The columns are the fields of the fullest
 * record; a record a repaint cut keeps the fields still on screen.
 */
function recordTable(lines: readonly string[]): Table | undefined {
  if (!lines.some(line => RECORD_RULE.test(line.trim()))) return undefined;
  const base = Math.min(...lines.map(indentOf));
  const records: [string, string][][] = [[]];
  for (const line of lines) {
    if (RECORD_RULE.test(line.trim())) { records.push([]); continue; }
    const record = records.at(-1)!;
    if (indentOf(line) > base) {
      const field = record.at(-1);
      if (field) field[1] = joinCell(field[1], line.trim());
      // A value whose field line a repaint cut off: only the first record can start this way.
      else if (records.length > 1) return undefined;
      continue;
    }
    const field = FIELD.exec(line.trim());
    if (!field) return undefined;
    record.push([field[1]!, field[2] ?? '']);
  }
  const filled = records.filter(record => record.length);
  const header = filled.reduce<[string, string][]>((most, record) => (record.length > most.length ? record : most), []).map(([name]) => name);
  if (header.length < 2) return undefined;
  const rows: string[][] = [];
  for (const record of filled) {
    // Each record's fields in the header's order, none twice.
    let at = 0;
    const row = header.map(() => '');
    for (const [name, value] of record) {
      at = header.indexOf(name, at);
      if (at < 0) return undefined;
      row[at++] = value;
    }
    rows.push(row);
  }
  return { header, rows };
}

/**
 * A paragraph made of tables as the TUI drew them, as Markdown; undefined when any of it is something else. A table
 * that outgrew the pane mid-stream is redrawn as records, and the box rows that had scrolled out stay above them: the
 * two halves become one table again when their headers agree.
 */
function drawnTables(lines: readonly string[]): string[] | undefined {
  const parts: (Table | string)[] = [];
  const key = (header: string[]) => header.join('\n').replace(/\s+/g, '');
  const add = (table: Table) => {
    const last = parts.at(-1);
    if (typeof last === 'object' && key(last.header) === key(table.header)) last.rows.push(...table.rows);
    else parts.push(table);
  };
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!.trim();
    if (MORE_ROWS.test(line)) { parts.push(escape(line)); at += 1; continue; }
    if (BOX_LINE.test(line)) {
      const box = boxTable(lines, at);
      if (!box) return undefined;
      add(box.table);
      at = box.next;
      continue;
    }
    let end = at;
    while (end < lines.length && !MORE_ROWS.test(lines[end]!.trim()) && !BOX_LINE.test(lines[end]!.trim())) end += 1;
    const records = recordTable(lines.slice(at, end));
    if (!records) return undefined;
    add(records);
    at = end;
  }
  return parts.map(part => {
    if (typeof part === 'string') return part;
    const row = (cells: readonly string[]) => `| ${part.header.map((_, i) => escape(cells[i] ?? '')).join(' | ')} |`;
    return [row(part.header), `|${part.header.map(() => ' --- |').join('')}`, ...part.rows.map(row)].join('\n');
  });
}

function fence(lines: readonly string[]): string {
  const longest = Math.max(2, ...lines.map(line => Math.max(0, ...[...line.matchAll(/`+/g)].map(run => run[0].length))));
  const mark = '`'.repeat(longest + 1);
  return `${mark}\n${lines.join('\n')}\n${mark}`;
}

/**
 * One paragraph as prose and items, or undefined when it is laid out by line: a line ending short where code would
 * (`;`, `{`, `}`) or a line set off by its indent. Any other short line is a break the answer made.
 */
function prose(lines: readonly string[], width: number): string | undefined {
  // A line of code on its own (`const a = 1;`, `}`): prose does not end in these.
  if (lines.length === 1 && !ITEM.test(lines[0]!) && CODE_END.test(lines[0]!)) return undefined;
  const out: string[] = [];
  let hang = 0, last = '';
  for (const line of lines) {
    const prev = out.at(-1), above = last;
    last = line;
    const item = ITEM.exec(line);
    const indent = /^\s*/.exec(line)![0].length;
    if (item) {
      hang = item[0].length;
      out.push(`${item[1]}${item[2]} ${escape(line.slice(item[0].length))}`);
      continue;
    }
    if (prev === undefined) { hang = indent; out.push(escape(line.trimStart())); continue; }
    if (indent === hang && wrapped(above, line, width)) { out[out.length - 1] = join(prev, escape(line)); continue; }
    if (indent !== hang || CODE_END.test(above.trimEnd()) || CODE_END.test(line.trimEnd())) return undefined;
    out[out.length - 1] = `${prev}\\`;
    out.push(`${' '.repeat(hang)}${escape(line.trimStart())}`);
  }
  return out.join('\n');
}

export function screenMarkdown(lines: readonly string[], width: number): string {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line.trim()) paragraphs.at(-1)!.push(line);
    else if (paragraphs.at(-1)!.length) paragraphs.push([]);
  }
  if (!paragraphs.at(-1)!.length) paragraphs.pop();
  const parts: string[] = [];
  let verbatim: string[] | undefined;
  for (const paragraph of paragraphs) {
    const boxed = paragraph.some(line => BOX.test(line));
    const tables = boxed ? drawnTables(paragraph) : undefined;
    const text = boxed ? undefined : prose(paragraph, width);
    if (text === undefined && !boxed) {
      // Code split by blank lines stays one block.
      verbatim = verbatim ? [...verbatim, '', ...paragraph] : [...paragraph];
      continue;
    }
    if (verbatim) { parts.push(fence(verbatim)); verbatim = undefined; }
    parts.push(...(tables ?? [text ?? fence(paragraph)]));
  }
  if (verbatim) parts.push(fence(verbatim));
  // An item whose text has not come yet.
  return parts.join('\n\n').replace(/\n?[^\S\n]*(?:[-*•]|\d+[.)]) ?$/, '');
}
