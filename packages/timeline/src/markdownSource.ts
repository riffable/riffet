/**
 * Fenced-code detection and the prose walker shared by the source rewrites that run before the
 * parser (`rewriteVisualizationReferences`, `protectBareUrls`, `relaxUnderscoreEmphasis`,
 * `escapeCurrencyDollars`): each must leave code alone, and each sees a fence inside a quote or a
 * list item, which the block scanner above them does not.
 */
export type Fence = { char: '`' | '~'; size: number };

export function removeContainerPrefix(line: string): string {
  let rest = line;
  for (let count = 0; count < 12; count += 1) {
    const indent = /^ {0,3}/.exec(rest)![0];
    rest = rest.slice(indent.length);
    if (rest.startsWith('>')) {
      rest = rest.slice(1).replace(/^ ?/, '');
      continue;
    }
    const list = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(rest);
    if (list) {
      rest = rest.slice(list[0].length);
      continue;
    }
    return rest;
  }
  return rest;
}

export function fenceRun(line: string): { char: '`' | '~'; size: number; rest: string } | undefined {
  const rest = removeContainerPrefix(line);
  const match = /^(`{3,}|~{3,})(.*)$/.exec(rest);
  if (!match || (match[1]![0] === '`' && match[2]!.includes('`'))) return undefined;
  return { char: match[1]![0] as '`' | '~', size: match[1]!.length, rest: match[2]! };
}

export function closesFence(line: string, fence: Fence): boolean {
  const rest = removeContainerPrefix(line);
  const match = /^(`+|~+)[ \t]*$/.exec(rest);
  return Boolean(match && match[1]![0] === fence.char && match[1]!.length >= fence.size);
}

/** A link's destination (`](…)`, `](<…>)`) or a definition (`[ref]: …`): not prose. */
export function inLinkTarget(text: string, index: number): boolean {
  let before = index;
  while (before > 0 && (text[before - 1] === ' ' || text[before - 1] === '\t')) before -= 1;
  const opening = text.slice(Math.max(0, before - 2), before);
  if (opening === '](' || opening === ']:') return true;
  // Further into a destination: the `(` still open here, and a `]` before it.
  let depth = 0;
  let open = -1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\\') { cursor += 1; continue; }
    if (text[cursor] === '(') { depth += 1; open = cursor; }
    else if (text[cursor] === ')' && depth > 0) { depth -= 1; if (depth === 0) open = -1; }
  }
  return open > 0 && text[open - 1] === ']';
}

/**
 * [transform] applied to the prose of [markdown] — the text outside fenced code blocks and inline
 * code spans — with everything else passing through byte for byte. A transform therefore cannot
 * rewrite an example a writer put in code.
 */
export function transformProse(markdown: string, transform: (text: string) => string): string {
  const output: string[] = [];
  let fence: Fence | undefined;
  let backticks: number | undefined;
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const carriage = rawLine.endsWith('\r') ? '\r' : '';
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      output.push(rawLine);
      continue;
    }
    // A blank line ends the paragraph an unclosed code span could continue into.
    if (/^[ \t]*$/.test(line)) backticks = undefined;
    // A fence interrupts a paragraph, so an unclosed backtick span above it does not hide it.
    const opener = fenceRun(line);
    if (opener) {
      fence = { char: opener.char, size: opener.size };
      backticks = undefined;
      output.push(rawLine);
      continue;
    }
    const state = { backticks };
    output.push(transformLine(line, state, transform) + carriage);
    backticks = state.backticks;
  }
  return output.join('\n');
}

function transformLine(line: string, state: { backticks: number | undefined }, transform: (text: string) => string): string {
  let out = '';
  let prose = '';
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === '`') {
      const run = runLength(line, index);
      if (!escaped(line, index)) {
        if (state.backticks === undefined) state.backticks = run;
        else if (state.backticks === run) state.backticks = undefined;
      }
      if (prose) { out += transform(prose); prose = ''; }
      out += line.slice(index, index + run);
      index += run;
      continue;
    }
    if (state.backticks === undefined) prose += char;
    else out += char;
    index += 1;
  }
  if (prose) out += transform(prose);
  return out;
}

/**
 * Roughly the text [markdown] renders to, for counting what a reader can find on the page: link
 * and image targets, emphasis and code-span markers, heading, quote, list and table syntax are
 * left out; a fenced block keeps its code and the language its header shows. Raw HTML stays,
 * because the renderer shows it as text. An approximation, not the parser: what it aims for is
 * that common writing counts the same as the page. Expects `relaxUnderscoreEmphasis` applied.
 */
export function visibleText(markdown: string): string {
  const lines = markdown.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const output: string[] = [];
  let fence: Fence | undefined;
  let table = false;
  lines.forEach((line, index) => {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      else output.push(line);
      return;
    }
    const opener = fenceRun(line);
    if (opener) {
      fence = { char: opener.char, size: opener.size };
      table = false;
      output.push(/^[\w+#.-]+/.exec(opener.rest.trim())?.[0] ?? 'text');
      return;
    }
    const rest = removeContainerPrefix(line);
    if (!rest.trim()) { table = false; return; }
    const next = lines[index + 1];
    if (!table && rest.includes('|') && next !== undefined && tableRule(removeContainerPrefix(next))) table = true;
    if (table) {
      // The rendered cells run together, with no text between them.
      if (!tableRule(rest)) output.push(rest.replace(/^[ \t]*\|/, '').replace(/\|[ \t]*$/, '').split(/(?<!\\)\|/).map((cell) => inlineText(cell.trim().replaceAll('\\|', '|'))).join(''));
      return;
    }
    // A rule or a setext underline draws a line, not text.
    if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line.replace(/^[ \t>]*/, '')) || /^=+[ \t]*$/.test(rest)) return;
    let text = rest;
    const heading = /^#{1,6}(?:[ \t]+|$)/.exec(text);
    if (heading) text = text.slice(heading[0].length).replace(/(?:^|[ \t]+)#+[ \t]*$/, '');
    else if (/^[ \t>]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\](?:[ \t]|$)/.test(line)) text = text.replace(/^\[[ xX]\][ \t]*/, '');
    output.push(inlineText(text));
  });
  return output.join('\n');
}

/** A table's delimiter row (`| --- | :-: |`), which makes the line above it a header. */
const tableRule = (line: string) => /^[ \t|:-]+$/.test(line) && line.includes('|') && line.includes('-');

/**
 * One line with its inline syntax taken out. Code spans are set aside first, so nothing inside one
 * reads as a marker, and escaped punctuation is held as a private-use character until the end.
 */
function inlineText(line: string): string {
  const codes: string[] = [];
  let text = '';
  for (let index = 0; index < line.length;) {
    const run = line[index] === '`' && !escaped(line, index) ? runLength(line, index) : 0;
    if (!run) { text += line[index]; index += 1; continue; }
    let close = line.indexOf('`', index + run);
    while (close >= 0 && runLength(line, close) !== run) close = line.indexOf('`', close + runLength(line, close));
    if (close < 0) { text += line.slice(index, index + run); index += run; continue; }
    const code = line.slice(index + run, close);
    // CommonMark drops one space from each side of a span padded on both.
    text += `${codes.push(/^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code) - 1}`;
    index = close + run;
  }
  return text
    .replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => String.fromCharCode(0xf000 + char.charCodeAt(0)))
    // An image shows no text of its own: its alt is an attribute.
    .replace(/!\[(?:[^[\]]|\[[^[\]]*\])*\]\((?:[^()]|\([^()]*\))*\)/g, '')
    .replace(/\[((?:[^[\]]|\[[^[\]]*\])*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/<([a-z][a-z\d+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/gi, '$1')
    .replace(/~~(?=\S)(.*?\S)~~/g, '$1')
    .replace(/\*\*(?=\S)(.*?\S)\*\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.*?\S)__(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/\*(?=\S)(.*?\S)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.*?\S)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/~(?=\S)(.*?\S)~/g, '$1')
    // A backslash ending the line is a hard break.
    .replace(/\\$/, '')
    .replace(/[-]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xf000))
    .replace(/(\d+)/g, (_, at: string) => codes[Number(at)]!);
}

function runLength(line: string, start: number): number {
  let end = start;
  while (line[end] === '`') end += 1;
  return end - start;
}

function escaped(line: string, index: number): boolean {
  let slashes = 0;
  for (let previous = index - 1; previous >= 0 && line[previous] === '\\'; previous -= 1) slashes += 1;
  return slashes % 2 === 1;
}
