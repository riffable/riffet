/**
 * Markdown for a text block as Claude Code drew it. The TUI renders the answer's Markdown and wraps it to the pane; what
 * is on screen has lost the marks (`##`, `**`, backticks, fences, link targets) and gained line breaks. This puts back
 * what can be told apart for certain, so the draft reads like the answer it stands in for:
 *
 * - wrapped lines are joined again where the next word would not have fitted (Ink wraps at the pane's width);
 * - bullets and numbered items stay items;
 * - a line ending short inside prose is a line break the answer made, and stays one;
 * - anything laid out by line — a table (box drawing), code — is kept as drawn, in a fence, since joining or reflowing
 *   it would garble it;
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
    const table = paragraph.some(line => BOX.test(line));
    const text = table ? undefined : prose(paragraph, width);
    if (text === undefined && !table) {
      // Code split by blank lines stays one block.
      verbatim = verbatim ? [...verbatim, '', ...paragraph] : [...paragraph];
      continue;
    }
    if (verbatim) { parts.push(fence(verbatim)); verbatim = undefined; }
    parts.push(text ?? fence(paragraph));
  }
  if (verbatim) parts.push(fence(verbatim));
  // An item whose text has not come yet.
  return parts.join('\n\n').replace(/\n?[^\S\n]*(?:[-*•]|\d+[.)]) ?$/, '');
}
