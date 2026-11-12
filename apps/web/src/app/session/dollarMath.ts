import { inLinkTarget, transformProse } from '../../../../../packages/timeline/src/markdownSource';

/**
 * `$5 到 $10` and `成本 $10/月，收益 $20/月` are prices, but micromark reads any `$…$` pair as
 * inline math and KaTeX turns the prose between them into a formula. Pandoc — and the Mac, which
 * takes its rule from it — asks two more things of a closing `$`: it does not follow a space, and
 * it is not followed by a digit. A span that fails either is not math here either: its dollars are
 * escaped (which renders as themselves), so the money stays money.
 *
 * Runs of `$$` are display math and are left alone; so are code spans and fences.
 */
export function escapeCurrencyDollars(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  return transformProse(markdown, escapeSegment);
}

function escapeSegment(text: string): string {
  if (!text.includes('$')) return text;
  const math = mathRanges(text);
  let out = '';
  let cursor = 0;
  for (const [start, end] of math) {
    out += escapeDollars(text.slice(cursor, start)) + text.slice(start, end + 1);
    cursor = end + 1;
  }
  return out + escapeDollars(text.slice(cursor));
}

/** Whether [index] falls inside a span this rule reads as math. */
export function insideMath(ranges: [number, number][], index: number): boolean {
  return ranges.some(([start, end]) => index > start && index <= end);
}

function escapeDollars(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '$') { out += text[index]; index += 1; continue; }
    const run = runLength(text, index);
    // `$$…$$` and `\$` are not single dollars to escape, and neither is a destination.
    if (run > 1 || escaped(text, index) || inLinkTarget(text, index)) out += '$'.repeat(run);
    else out += '\\$';
    index += run;
  }
  return out;
}

/** The `$…$` spans that are math by the rule above, left to right. */
export function mathRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let index = 0;
  while (index < text.length) {
    const dollar = text.indexOf('$', index);
    if (dollar < 0) break;
    const run = runLength(text, dollar);
    if (run !== 1 || escaped(text, dollar) || inLinkTarget(text, dollar)) {
      index = dollar + run;
      continue;
    }
    const close = closingDollar(text, dollar);
    if (close !== undefined && isMath(text, dollar, close)) {
      ranges.push([dollar, close]);
      index = close + 1;
      continue;
    }
    index = dollar + 1;
  }
  return ranges;
}

/** Pandoc's reading of the span between two single dollars. */
function isMath(text: string, open: number, close: number): boolean {
  if (close <= open + 1) return false;
  if (/\s/.test(text[open + 1]!)) return false;
  if (/\s/.test(text[close - 1]!)) return false;
  return !/^[0-9]/.test(text[close + 1] ?? '');
}

/** The next single-dollar closer after [open], skipping escaped dollars and `$$` runs. */
function closingDollar(text: string, open: number): number | undefined {
  let index = open + 1;
  while (index < text.length) {
    const dollar = text.indexOf('$', index);
    if (dollar < 0) return undefined;
    const run = runLength(text, dollar);
    if (run === 1 && !escaped(text, dollar)) return dollar;
    index = dollar + run;
  }
  return undefined;
}

function runLength(text: string, start: number): number {
  let end = start;
  while (text[end] === '$') end += 1;
  return end - start;
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let previous = index - 1; previous >= 0 && text[previous] === '\\'; previous -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** remark-math accepts dollar delimiters; TeX's slash delimiters are common in model responses. */
export function normalizeSlashMath(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) return markdown;
  // Mark only prose delimiters before pairing across lines. Code examples and link targets stay
  // byte-for-byte intact, and an unfinished formula remains readable while a response streams.
  let marker = '\uE000';
  while (markdown.includes(marker)) marker += '\uE000';
  const marked = transformProse(markdown, (text) => text.replace(/\\[()[\]]/g, (match: string, offset: number) =>
    escaped(text, offset) || inLinkTarget(text, offset) ? match : `${marker}${match[1]}${marker}`));
  const inline = new RegExp(`${marker}\\(${marker}([^\\n]+?)${marker}\\)${marker}`, 'g');
  const display = new RegExp(`${marker}\\[${marker}([\\s\\S]*?)${marker}\\]${marker}`, 'g');
  return marked
    .replace(inline, (_match: string, body: string) => `$${body.trim()}$`)
    .replace(display, (match: string, body: string, offset: number, source: string) => {
      const prefix = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset);
      // Every new line must remain in the opener's quote/list. List markers become indentation
      // on continuation lines; repeating `- ` would create another item for each formula line.
      const container = /^[ \t]*(?:(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)[ \t]*)*/.exec(prefix)![0];
      const continuation = container.replace(/(?:[-+*]|\d{1,9}[.)])(?=[ \t])/g, (marker) => ' '.repeat(marker.length));
      const formula = body.split('\n').map((line, index) => (
        index > 0 && line.startsWith(continuation) ? line.slice(continuation.length) : line
      )).join('\n').trim();
      const end = offset + match.length;
      const lineEnd = source.indexOf('\n', end);
      const suffix = source.slice(end, lineEnd < 0 ? undefined : lineEnd);
      const content = formula.split('\n').map((line) => continuation + line).join('\n');
      return `${prefix === container ? '' : `\n${continuation}`}$$\n${content}\n${continuation}$$${suffix.trim() ? `\n${continuation}` : ''}`;
    })
    .replace(new RegExp(`${marker}([()[\\]])${marker}`, 'g'), (_match: string, delimiter: string) => `\\${delimiter}`);
}
