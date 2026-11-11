/** A whitespace line reaching column 4 can still be indented code content, so it is not a gap here. */
const BLANK = /^ {0,3}$/;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** Backtick fences may not carry a backtick in their info string; `$$` math fences no `$`. */
const FENCE = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,}|\${2,}(?=[^$]*$))/;
/** A fence run anywhere a container could hold it: indented, or after `>` and list markers. */
const NESTED_FENCE = /^(?:[ \t]+|[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)+)(?:`{3,}|~{3,}|\${2,})/;
/** The start of a possible HTML block; several kinds run on until a blank line or their end tag. */
const HTML = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*<[A-Za-z/!?]/;
/** micromark reads an empty list item as text when it directly follows indented code, so it never starts a block. */
const EMPTY_ITEM = /^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]*$/;
/** Link reference and footnote definitions apply to the whole document, wherever they stand. */
const DEFINITION = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*\[(?:[^\]\\\n]|\\.)+\]:/;

/**
 * Splits Markdown into top-level blocks that parse the same apart as together, so a streaming
 * message re-parses only its last, still-growing block.
 *
 * A split is made only at a blank line followed by a line in column 0 that is not a list marker:
 * no open block survives that (a list item needs indented content, and nothing continues lazily
 * across a blank line) except a fenced code or math block, which is tracked here when it opens at
 * the top level. Whatever cannot be followed exactly ends the splitting, and the rest stays one
 * block: a fence that may sit in a list item or quote (it can swallow the blank line before the
 * item closes), or an HTML block (some kinds run past blank lines, and any of them hides a fence).
 * A definition anywhere, or a carriage return, keeps the whole text one block, since a definition
 * reaches every block. Blocks are cut before their separating blank lines; the renderer puts back
 * the newline the whole-document parse places between top-level nodes.
 */
export function markdownBlocks(text: string): string[] {
  if (text.includes('\r')) return [text];
  const blocks: string[] = [];
  let blockStart = 0;
  /** End of the last non-blank line, or -1 while the current block has none. */
  let contentEnd = -1;
  let blankSince = false;
  let fence: { char: string; size: number } | undefined;
  let listSeen = false;
  let frozen = false;
  let offset = 0;
  for (;;) {
    const newline = text.indexOf('\n', offset);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end);
    if (fence) {
      // Once splitting has stopped the fence is only a guess, so a definition inside it still counts.
      if (frozen && DEFINITION.test(line)) return [text];
      const close = FENCE.exec(line);
      if (close && close[2]![0] === fence.char && close[2]!.length >= fence.size && /^[ \t]*$/.test(line.slice(close[0].length))) fence = undefined;
      contentEnd = end;
    } else if (BLANK.test(line)) {
      if (contentEnd >= 0) blankSince = true;
    } else if (/^[ \t]*$/.test(line)) {
      // Never a block of its own (it would parse to nothing), but it may still be code content.
      if (contentEnd >= 0) { contentEnd = end; blankSince = false; }
    } else {
      if (DEFINITION.test(line)) return [text];
      if (blankSince && !frozen && !/^[ \t]/.test(line) && !LIST_MARKER.test(line) && !EMPTY_ITEM.test(line)) {
        blocks.push(text.slice(blockStart, contentEnd));
        blockStart = offset;
        listSeen = false;
      }
      blankSince = false;
      contentEnd = end;
      if (LIST_MARKER.test(line)) listSeen = true;
      if (HTML.test(line)) frozen = true;
      const open = FENCE.exec(line);
      if (open) {
        if (open[1]!.length && listSeen) frozen = true;
        fence = { char: open[2]![0]!, size: open[2]!.length };
      } else if (NESTED_FENCE.test(line)) frozen = true;
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}
