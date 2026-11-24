interface ListFrame {
  markerIndent: number;
  contentIndent: number;
  kind: 'ul' | 'ol';
  bullet: string;
  orderNumber: number;
  lastLineEndedWithColon: boolean;
}

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_MARKER = /^(?:([-+*])|(\d{1,9})([.)]))(?:([ \t]+)(.*)|([ \t]*))$/;
const FENCE_OPENER = /^(`{3,}(?=[^`]*$)|~{3,}|\${2,}(?=[^$]*$))(.*)$/;
const CITATION_INFO = /^\d+:\d+:.+/;
const ENDS_WITH_COLON = /[:：]\s*$/;

function leadingIndent(line: string): { chars: number; cols: number } {
  let chars = 0;
  let cols = 0;
  while (chars < line.length) {
    const ch = line[chars]!;
    if (ch === ' ') {
      cols += 1;
    } else if (ch === '\t') {
      cols += 4 - (cols % 4);
    } else {
      break;
    }
    chars += 1;
  }
  return { chars, cols };
}

function parseListMarker(
  line: string,
  stack: readonly ListFrame[],
): { markerIndent: number; contentIndent: number; kind: 'ul' | 'ol'; bullet: string; orderNumber: number; endedWithColon: boolean } | undefined {
  if (THEMATIC_BREAK.test(line)) return undefined;
  const { chars, cols } = leadingIndent(line);
  const parentContent = stack.length > 0 ? stack[stack.length - 1]!.contentIndent : 0;
  // CommonMark treats a marker indented 4+ columns past its enclosing content as indented code.
  const limit = stack.length === 0 ? 4 : parentContent + 4;
  if (cols >= limit) return undefined;
  const rest = line.slice(chars);
  const match = LIST_MARKER.exec(rest);
  if (!match) return undefined;
  const marker = match[1] ?? `${match[2]}${match[3]}`;
  const kind: 'ul' | 'ol' = match[1] ? 'ul' : 'ol';
  const bullet = match[1] ?? match[3]!;
  const orderNumber = match[2] ? Number(match[2]) : 0;
  const spacesRaw = match[4] ?? '';
  const body = match[5] ?? '';
  let spaceCols = 0;
  for (const ch of spacesRaw) {
    spaceCols += ch === '\t' ? 4 - ((cols + marker.length + spaceCols) % 4) : 1;
  }
  const effectiveSpaces = !body.trim() || spaceCols >= 5 ? 1 : spaceCols;
  return {
    markerIndent: cols,
    contentIndent: cols + marker.length + effectiveSpaces,
    kind,
    bullet,
    orderNumber,
    endedWithColon: ENDS_WITH_COLON.test(body),
  };
}

function parseFenceOpener(
  line: string,
): { indent: number; chars: number; char: '`' | '~' | '$'; size: number; info: string } | undefined {
  const { chars, cols } = leadingIndent(line);
  const match = FENCE_OPENER.exec(line.slice(chars));
  if (!match) return undefined;
  const run = match[1]!;
  const info = match[2]!.trim();
  const char = run[0] as '`' | '~' | '$';
  return { indent: cols, chars, char, size: run.length, info };
}

function isFenceCloser(line: string, char: '`' | '~' | '$', size: number, maxIndentCols: number): boolean {
  const { chars, cols } = leadingIndent(line);
  if (cols > maxIndentCols) return false;
  const rest = line.slice(chars).trimEnd();
  if (rest.length < size) return false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== char) return false;
  }
  return true;
}

function indentLine(rawLine: string, extraCols: number): string {
  if (extraCols <= 0) return rawLine;
  const carriage = rawLine.endsWith('\r') ? '\r' : '';
  const line = carriage ? rawLine.slice(0, -1) : rawLine;
  if (!line.trim()) return carriage;
  const { chars, cols } = leadingIndent(line);
  return `${' '.repeat(cols + extraCols)}${line.slice(chars)}${carriage}`;
}

function findMatchingCloser(
  lines: readonly string[],
  startIndex: number,
  char: '`' | '~' | '$',
  size: number,
  maxIndentCols: number,
): number | undefined {
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!.endsWith('\r') ? lines[i]!.slice(0, -1) : lines[i]!;
    if (isFenceCloser(line, char, size, maxIndentCols)) return i;
  }
  return undefined;
}

function continuedFrameAfter(
  lines: readonly string[],
  afterIndex: number,
  stack: readonly ListFrame[],
): { frame: ListFrame; blankAfter: boolean; orderNumber: number } | undefined {
  let blankAfter = false;
  for (let i = afterIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!.endsWith('\r') ? lines[i]!.slice(0, -1) : lines[i]!;
    if (!line.trim()) {
      blankAfter = true;
      continue;
    }
    const { chars, cols } = leadingIndent(line);
    if (THEMATIC_BREAK.test(line)) return undefined;
    const match = LIST_MARKER.exec(line.slice(chars));
    if (!match) return undefined;
    const kind: 'ul' | 'ol' = match[1] ? 'ul' : 'ol';
    const bullet = match[1] ?? match[3]!;
    const orderNumber = match[2] ? Number(match[2]) : 0;
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      const frame = stack[s]!;
      if (cols >= frame.markerIndent && cols < frame.contentIndent && frame.kind === kind && frame.bullet === bullet) {
        return { frame, blankAfter, orderNumber };
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * Keeps fenced code (and display math) blocks inside the list item they belong to when an agent
 * leaves their opening/closing fences at column 0 (for example Cursor's ```` ```start:end:path ````
 * citations, whose prompt forbids indenting triple backticks) or indents them fewer spaces than
 * the enclosing list marker requires (e.g. 2 spaces under `10. ` or a nested `- `).
 *
 * Designed to avoid false positives: a top-level fence separated by a blank line after a list
 * (and not continuing an indented/ordered list or introduced as a citation by `:`/`：`) stays at
 * column 0.
 */
export function alignListFences(markdown: string): string {
  if (!markdown.includes('```') && !markdown.includes('~~~') && !markdown.includes('$$')) return markdown;

  const rawLines = markdown.split('\n');
  const output: string[] = [];
  const stack: ListFrame[] = [];
  let blankLines = 0;
  let activeFence: { char: '`' | '~' | '$'; size: number; maxCloserIndent: number; extraIndent: number } | undefined;

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index]!;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (activeFence) {
      output.push(indentLine(rawLine, activeFence.extraIndent));
      if (isFenceCloser(line, activeFence.char, activeFence.size, activeFence.maxCloserIndent)) {
        activeFence = undefined;
        blankLines = 0;
      }
      continue;
    }

    if (!line.trim()) {
      blankLines += 1;
      if (blankLines >= 2 && stack.length > 0) {
        stack[stack.length - 1]!.lastLineEndedWithColon = false;
      }
      output.push(rawLine);
      continue;
    }

    const fence = stack.length > 0 ? parseFenceOpener(line) : undefined;
    if (fence) {
      const top = stack[stack.length - 1]!;
      const sawBlank = blankLines > 0;
      if (fence.indent >= top.contentIndent) {
        top.lastLineEndedWithColon = false;
        activeFence = { char: fence.char, size: fence.size, maxCloserIndent: fence.indent + 3, extraIndent: 0 };
        blankLines = 0;
        output.push(rawLine);
        continue;
      }

      const closerIndex = findMatchingCloser(rawLines, index, fence.char, fence.size, fence.indent + 3);
      const continued = closerIndex !== undefined ? continuedFrameAfter(rawLines, closerIndex, stack) : undefined;
      const continues = continued?.frame;
      const citation = fence.char === '`' && CITATION_INFO.test(fence.info);
      const strongContinuation = Boolean(
        continued
        && (continued.frame.markerIndent > 0
          || !continued.blankAfter
          || (continued.frame.kind === 'ol' && continued.orderNumber > continued.frame.orderNumber)),
      );

      let target: ListFrame | undefined;
      if (fence.indent > 0) {
        let matchingOuter: ListFrame | undefined;
        for (let s = stack.length - 1; s >= 0; s -= 1) {
          if (stack[s]!.contentIndent <= fence.indent) {
            matchingOuter = stack[s];
            break;
          }
        }
        const resumesInner = Boolean(continues && matchingOuter && continues.markerIndent > matchingOuter.markerIndent);
        if (matchingOuter && !resumesInner && (!citation || (sawBlank && !top.lastLineEndedWithColon))) {
          while (stack.length > 0 && stack[stack.length - 1] !== matchingOuter) stack.pop();
        } else {
          target = top;
        }
      } else {
        // Column-0 citation fences belong to the list item when attached without a blank line,
        // introduced by a trailing colon (after at most one blank line), or followed by a list
        // continuation. Ordinary column-0 fences only indent when followed by a list continuation.
        const shouldIndent = citation
          ? !sawBlank || (blankLines <= 1 && top.lastLineEndedWithColon) || strongContinuation
          : strongContinuation && (!sawBlank || continued!.frame.markerIndent > 0 || continued!.frame.kind === 'ol');
        if (shouldIndent) {
          target = continues && sawBlank && !top.lastLineEndedWithColon ? continues : top;
        } else {
          stack.length = 0;
        }
      }

      if (target) {
        while (stack.length > 0 && stack[stack.length - 1] !== target) stack.pop();
        target.lastLineEndedWithColon = false;
        const extra = target.contentIndent - fence.indent;
        activeFence = { char: fence.char, size: fence.size, maxCloserIndent: fence.indent + 3, extraIndent: extra };
        blankLines = 0;
        output.push(indentLine(rawLine, extra));
        continue;
      }

      if (stack.length > 0) stack[stack.length - 1]!.lastLineEndedWithColon = false;
      activeFence = { char: fence.char, size: fence.size, maxCloserIndent: fence.indent + 3, extraIndent: 0 };
      blankLines = 0;
      output.push(rawLine);
      continue;
    }

    // Track fences outside lists too so list-like lines inside top-level code blocks are ignored.
    if (stack.length === 0) {
      const topFence = parseFenceOpener(line);
      if (topFence && topFence.indent < 4) {
        activeFence = { char: topFence.char, size: topFence.size, maxCloserIndent: 3, extraIndent: 0 };
        blankLines = 0;
        output.push(rawLine);
        continue;
      }
    }

    const marker = parseListMarker(line, stack);
    if (marker) {
      while (stack.length > 0 && marker.markerIndent < stack[stack.length - 1]!.contentIndent) {
        stack.pop();
      }
      stack.push({
        markerIndent: marker.markerIndent,
        contentIndent: marker.contentIndent,
        kind: marker.kind,
        bullet: marker.bullet,
        orderNumber: marker.orderNumber,
        lastLineEndedWithColon: marker.endedWithColon,
      });
      blankLines = 0;
      output.push(rawLine);
      continue;
    }

    if (stack.length > 0) {
      const { chars, cols } = leadingIndent(line);
      if (blankLines > 0) {
        while (stack.length > 0 && cols < stack[stack.length - 1]!.contentIndent) {
          stack.pop();
        }
      } else {
        const trimmed = line.slice(chars);
        if (THEMATIC_BREAK.test(line) || /^#{1,6}(?:[ \t]|$)/.test(trimmed) || trimmed.startsWith('>')) {
          while (stack.length > 0 && cols < stack[stack.length - 1]!.contentIndent) {
            stack.pop();
          }
        }
      }
      if (stack.length > 0) {
        stack[stack.length - 1]!.lastLineEndedWithColon = ENDS_WITH_COLON.test(line);
      }
      blankLines = 0;
    }

    output.push(rawLine);
  }

  return output.join('\n');
}
