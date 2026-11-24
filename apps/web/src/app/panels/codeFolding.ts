import type { EditorState, Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { codeFolding, foldAll, foldCode, foldGutter, foldKeymap, foldService, unfoldAll, unfoldCode } from '@codemirror/language';

/*
 * Folding without a parser: the shown file has TextMate tokens for colour, not a syntax tree, so the
 * blocks are found from the text, as an IDE's fallback folding does. A line folds when it opens a
 * brace block that closes on a later line, starts a block comment that ends on a later line, or
 * starts a run of imports. Braces inside strings and comments are skipped; a block that opens inside
 * a comment or string begun on an earlier line can be misread, which costs a wrong fold, never text.
 */

/** Characters read past a line looking for its closing brace: a class body can run to the end of a large file. */
const SCAN_CHARS = 2_000_000;
const IMPORT = /^\s*import\s/;
const BLANK = /^\s*$/;

type Mode = 'code' | 'line-comment' | 'block-comment' | 'string' | 'char' | 'raw-string';

/**
 * Walks text from `from`, calling `visit` with each brace that is code (not in a string or comment);
 * `visit` returns true to stop. Starts in code.
 */
function scanBraces(state: EditorState, from: number, to: number, visit: (char: '{' | '}', at: number) => boolean): void {
  let mode: Mode = 'code';
  const text = state.doc.sliceString(from, to);
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    switch (mode) {
      case 'code':
        if (char === '/' && next === '/') { mode = 'line-comment'; index++; }
        else if (char === '/' && next === '*') { mode = 'block-comment'; index++; }
        else if (char === '"' && next === '"' && text[index + 2] === '"') { mode = 'raw-string'; index += 2; }
        else if (char === '"') mode = 'string';
        else if (char === '\'') mode = 'char';
        else if ((char === '{' || char === '}') && visit(char, from + index)) return;
        break;
      case 'line-comment': if (char === '\n') mode = 'code'; break;
      case 'block-comment': if (char === '*' && next === '/') { mode = 'code'; index++; } break;
      case 'raw-string': if (char === '"' && next === '"' && text[index + 2] === '"') { mode = 'code'; index += 2; } break;
      case 'string': case 'char':
        if (char === '\\') index++;
        else if (char === (mode === 'string' ? '"' : '\'') || char === '\n') mode = 'code';
        break;
    }
  }
}

/** The block a line opens with its last unclosed `{`, from after it to its `}` on a later line. */
function braceBlock(state: EditorState, lineFrom: number, lineTo: number): { from: number; to: number } | null {
  const open: number[] = [];
  scanBraces(state, lineFrom, lineTo, (char, at) => { if (char === '{') open.push(at); else open.pop(); return false; });
  const start = open.at(-1);
  if (start === undefined) return null;
  let depth = 0;
  let end = -1;
  scanBraces(state, start, Math.min(state.doc.length, start + SCAN_CHARS), (char, at) => {
    depth += char === '{' ? 1 : -1;
    if (depth === 0) { end = at; return true; }
    return false;
  });
  if (end < 0 || end <= lineTo) return null;
  return { from: start + 1, to: end };
}

function commentBlock(state: EditorState, lineFrom: number, lineText: string): { from: number; to: number } | null {
  const at = lineText.search(/\S/);
  if (at < 0 || !lineText.startsWith('/*', at)) return null;
  const open = lineFrom + at + 2;
  const close = state.doc.sliceString(open, Math.min(state.doc.length, open + SCAN_CHARS)).indexOf('*/');
  if (close < 0) return null;
  const end = open + close;
  return end > lineFrom + lineText.length ? { from: open, to: end } : null;
}

/** A run of imports, blank lines between them included, folded after the first `import`. */
function importBlock(state: EditorState, lineNumber: number, lineText: string): { from: number; to: number } | null {
  if (!IMPORT.test(lineText) || (lineNumber > 1 && IMPORT.test(state.doc.line(lineNumber - 1).text))) return null;
  let last = lineNumber;
  for (let number = lineNumber + 1; number <= state.doc.lines; number++) {
    const text = state.doc.line(number).text;
    if (IMPORT.test(text)) last = number;
    else if (!BLANK.test(text)) break;
  }
  if (last === lineNumber) return null;
  const first = state.doc.line(lineNumber);
  return { from: first.from + lineText.indexOf('import') + 'import'.length, to: state.doc.line(last).to };
}

const service = foldService.of((state, lineFrom, lineTo) => {
  const line = state.doc.lineAt(lineFrom);
  return importBlock(state, line.number, line.text) ?? commentBlock(state, lineFrom, line.text) ?? braceBlock(state, lineFrom, lineTo);
});

function chevron(open: boolean): HTMLElement {
  const element = document.createElement('span');
  element.className = open ? 'cm-fold-open' : 'cm-fold-closed';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', open ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6');
  svg.append(path);
  element.append(svg);
  return element;
}

/**
 * Folding for a read-only file: a gutter of chevrons (shown while the pointer is over the gutter, a
 * folded line's always), a `…` placeholder that unfolds on click, and the IDE's keys: ⌘- / ⌘= fold
 * and unfold at the caret, with ⇧ for the whole file, besides CodeMirror's own.
 */
export function codeFoldingExtension(labels: { unfold: string }): Extension {
  return [
    service,
    codeFolding({
      placeholderDOM: (_view, onclick) => {
        const element = document.createElement('span');
        element.className = 'cm-foldPlaceholder';
        element.textContent = '…';
        element.title = labels.unfold;
        element.onclick = onclick;
        return element;
      },
    }),
    foldGutter({ markerDOM: chevron }),
    keymap.of([
      { key: 'Mod--', run: foldCode, preventDefault: true },
      { key: 'Mod-=', run: unfoldCode, preventDefault: true },
      { key: 'Mod-Shift--', run: foldAll, preventDefault: true },
      { key: 'Mod-Shift-=', run: unfoldAll, preventDefault: true },
      ...foldKeymap,
    ]),
  ];
}
