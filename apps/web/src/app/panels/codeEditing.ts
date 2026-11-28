import { EditorSelection, EditorState, type ChangeSpec, type Extension } from '@codemirror/state';
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLineGutter, highlightSpecialChars, keymap,
  rectangularSelection,
} from '@codemirror/view';
import {
  copyLineDown, copyLineUp, defaultKeymap, deleteLine, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp,
  toggleComment,
} from '@codemirror/commands';
import { bracketMatching, indentUnit } from '@codemirror/language';
import { searchPanelOpen, selectNextOccurrence } from '@codemirror/search';

/** Indentation style of an editor buffer: spaces (2 or 4) or tabs. */
export interface CodeIndent { kind: 'spaces' | 'tabs'; size: 2 | 4 }

const FOUR_SPACE_EXTS = new Set(['kt', 'kts', 'java', 'py', 'cs', 'php', 'swift', 'gradle', 'groovy', 'rs', 'go', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'aidl', 'proto']);

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
};

/** Guesses a file's indentation from its first indented lines, falling back to the language's norm. */
export function detectIndent(text: string, path: string): CodeIndent {
  let tabs = 0;
  let spaces = 0;
  let twoDiffs = 0;
  let fourDiffs = 0;
  let prevSpaces = 0;
  let inspected = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && inspected < 200; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (line.startsWith('\t')) {
      tabs++;
      inspected++;
      continue;
    }
    const match = /^( +)\S/.exec(line);
    if (!match) { prevSpaces = 0; continue; }
    const count = match[1]!.length;
    spaces++;
    inspected++;
    const diff = Math.abs(count - prevSpaces);
    if (diff === 2) twoDiffs++;
    else if (diff === 4) fourDiffs++;
    else if (count === 2) twoDiffs++;
    else if (count === 4) fourDiffs++;
    prevSpaces = count;
  }
  if (tabs > spaces) return { kind: 'tabs', size: 4 };
  if (spaces > 0) return { kind: 'spaces', size: twoDiffs > fourDiffs ? 2 : 4 };
  return { kind: 'spaces', size: FOUR_SPACE_EXTS.has(extensionOf(path)) ? 4 : 2 };
}

/** Detects whether the raw file uses CRLF throughout, for the status bar indicator. */
export function detectLineEnding(text: string): 'LF' | 'CRLF' {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text) ? 'CRLF' : 'LF';
}

interface CommentTokens { line?: string; block?: { open: string; close: string } }

const SLASH_COMMENT: CommentTokens = { line: '//', block: { open: '/*', close: '*/' } };
const HASH_COMMENT: CommentTokens = { line: '#' };
const HTML_COMMENT: CommentTokens = { block: { open: '<!--', close: '-->' } };
const CSS_COMMENT: CommentTokens = { block: { open: '/*', close: '*/' } };
const SQL_COMMENT: CommentTokens = { line: '--', block: { open: '/*', close: '*/' } };
const LUA_COMMENT: CommentTokens = { line: '--', block: { open: '--[[', close: ']]' } };

const COMMENT_BY_EXT: Record<string, CommentTokens> = {
  kt: SLASH_COMMENT, kts: SLASH_COMMENT, java: SLASH_COMMENT, gradle: SLASH_COMMENT, groovy: SLASH_COMMENT,
  ts: SLASH_COMMENT, mts: SLASH_COMMENT, cts: SLASH_COMMENT, tsx: SLASH_COMMENT,
  js: SLASH_COMMENT, mjs: SLASH_COMMENT, cjs: SLASH_COMMENT, jsx: SLASH_COMMENT,
  c: SLASH_COMMENT, h: SLASH_COMMENT, cc: SLASH_COMMENT, cpp: SLASH_COMMENT, cxx: SLASH_COMMENT, hpp: SLASH_COMMENT, hh: SLASH_COMMENT,
  m: SLASH_COMMENT, mm: SLASH_COMMENT, cs: SLASH_COMMENT, go: SLASH_COMMENT, rs: SLASH_COMMENT, swift: SLASH_COMMENT,
  dart: SLASH_COMMENT, scala: SLASH_COMMENT, php: SLASH_COMMENT, jsonc: SLASH_COMMENT, json5: SLASH_COMMENT,
  proto: SLASH_COMMENT, aidl: SLASH_COMMENT, scss: SLASH_COMMENT, less: SLASH_COMMENT,
  py: HASH_COMMENT, sh: HASH_COMMENT, bash: HASH_COMMENT, zsh: HASH_COMMENT,
  yaml: HASH_COMMENT, yml: HASH_COMMENT, toml: HASH_COMMENT, rb: HASH_COMMENT,
  ini: HASH_COMMENT, cfg: HASH_COMMENT, conf: HASH_COMMENT, properties: HASH_COMMENT, pro: HASH_COMMENT,
  cmake: HASH_COMMENT, mk: HASH_COMMENT, graphql: HASH_COMMENT, gql: HASH_COMMENT,
  html: HTML_COMMENT, htm: HTML_COMMENT, xml: HTML_COMMENT, svg: HTML_COMMENT, plist: HTML_COMMENT,
  vue: HTML_COMMENT, svelte: HTML_COMMENT, md: HTML_COMMENT, markdown: HTML_COMMENT, mdx: HTML_COMMENT, mdc: HTML_COMMENT,
  css: CSS_COMMENT,
  sql: SQL_COMMENT,
  lua: LUA_COMMENT,
};

const COMMENT_BY_NAME: Record<string, CommentTokens> = {
  dockerfile: HASH_COMMENT, makefile: HASH_COMMENT, gnumakefile: HASH_COMMENT, 'cmakelists.txt': HASH_COMMENT,
};

/** Registers line and block comment syntax for the file's language so `toggleComment` (`Mod-/`) works. */
export function languageCommentData(path: string): Extension {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const tokens = COMMENT_BY_NAME[name] ?? COMMENT_BY_EXT[extensionOf(path)];
  return tokens ? EditorState.languageData.of(() => [{ commentTokens: tokens }]) : [];
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSERS = new Set([')', ']', '}']);
const QUOTES = new Set(['"', "'", '`']);
const WORD_CHAR = /[\w$]/;
const INDENT_OPENERS = /[{([:]$/;

/** Returns one unit of indentation as configured in `state`. */
const indentStep = (state: EditorState) => state.facet(indentUnit) || '  ';

/**
 * Lightweight IDE bracket & quote pairing plus smart Enter indentation without requiring a full
 * language parser:
 * - Typing an opener wraps active selections, or inserts the matching closer when not inside a word.
 * - Typing a closer skips over an identical closer already ahead of the caret.
 * - Backspace inside an empty pair removes both characters.
 * - Enter inside `{|}`, `(|)`, `[|]` expands into an indented block; Enter after `{`, `(`, `[`, `:` indents.
 */
function autoCloseAndIndentExtension(): Extension {
  const inputHandler = EditorView.inputHandler.of((view, from, to, text) => {
    if (text.length !== 1) return false;
    const { state } = view;
    const close = PAIRS[text];
    const isQuote = QUOTES.has(text);

    // Non-empty selection: wrap every range with the pair.
    if (close && state.selection.ranges.some((range) => !range.empty)) {
      const transaction = state.changeByRange((range) => {
        if (range.empty) return { range, changes: { from: range.from, to: range.to, insert: text } };
        return {
          changes: [{ from: range.from, insert: text }, { from: range.to, insert: close }],
          range: EditorSelection.range(range.from + 1, range.to + 1),
        };
      });
      view.dispatch(transaction, { userEvent: 'input.type' });
      return true;
    }

    // Only handle single-character insertion at collapsed cursors.
    if (from !== to) return false;

    // Skip over an existing closing bracket or quote directly ahead.
    if ((CLOSERS.has(text) || isQuote) && state.selection.ranges.every((range) => range.empty && state.sliceDoc(range.from, range.from + 1) === text)) {
      view.dispatch({
        selection: EditorSelection.create(state.selection.ranges.map((range) => EditorSelection.cursor(range.from + 1)), state.selection.mainIndex),
        userEvent: 'input.type',
      });
      return true;
    }

    if (!close) return false;

    // Avoid auto-pairing right before a word char, or quotes right after a word char / escape / same quote.
    const canPair = state.selection.ranges.every((range) => {
      if (!range.empty) return false;
      const next = state.sliceDoc(range.from, range.from + 1);
      if (next && WORD_CHAR.test(next)) return false;
      if (isQuote) {
        const prev = range.from > 0 ? state.sliceDoc(range.from - 1, range.from) : '';
        if (prev && (WORD_CHAR.test(prev) || prev === '\\' || prev === text)) return false;
      }
      return true;
    });
    if (!canPair) return false;

    const transaction = state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text + close },
      range: EditorSelection.cursor(range.from + 1),
    }));
    view.dispatch(transaction, { userEvent: 'input.type' });
    return true;
  });

  const smartKeys = keymap.of([
    {
      key: 'Backspace',
      run: (view) => {
        const { state } = view;
        if (!state.selection.ranges.every((range) => range.empty && range.from > 0)) return false;
        const allEmptyPairs = state.selection.ranges.every((range) => {
          const prev = state.sliceDoc(range.from - 1, range.from);
          const next = state.sliceDoc(range.from, range.from + 1);
          return PAIRS[prev] === next;
        });
        if (!allEmptyPairs) return false;
        const transaction = state.changeByRange((range) => ({
          changes: { from: range.from - 1, to: range.from + 1 },
          range: EditorSelection.cursor(range.from - 1),
        }));
        view.dispatch(transaction, { userEvent: 'delete.backward' });
        return true;
      },
    },
    {
      key: 'Enter',
      run: (view) => {
        const { state } = view;
        const step = indentStep(state);
        const changes: ChangeSpec[] = [];
        const ranges: typeof state.selection.ranges[number][] = [];
        let offset = 0;
        for (const range of state.selection.ranges) {
          const line = state.doc.lineAt(range.from);
          const leading = /^[\t ]*/.exec(line.text)?.[0] ?? '';
          const before = state.sliceDoc(line.from, range.from).trimEnd();
          const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + 1));
          const opener = before.at(-1);
          const betweenPair = opener !== undefined && (opener === '{' || opener === '(' || opener === '[') && PAIRS[opener] === after;
          let insert: string;
          let cursorDelta: number;
          if (betweenPair) {
            insert = `\n${leading}${step}\n${leading}`;
            cursorDelta = 1 + leading.length + step.length;
          } else if (opener !== undefined && INDENT_OPENERS.test(opener)) {
            insert = `\n${leading}${step}`;
            cursorDelta = insert.length;
          } else {
            insert = `\n${leading}`;
            cursorDelta = insert.length;
          }
          changes.push({ from: range.from, to: range.to, insert });
          const cursorPos = range.from + offset + cursorDelta;
          ranges.push(EditorSelection.cursor(cursorPos));
          offset += insert.length - (range.to - range.from);
        }
        view.dispatch({
          changes,
          selection: EditorSelection.create(ranges, state.selection.mainIndex),
          scrollIntoView: true,
          userEvent: 'input.enter',
        });
        return true;
      },
    },
  ]);

  return [inputHandler, smartKeys];
}

/** Indentation compartment extension: tab display width + indent unit. */
export function indentExtension(indent: CodeIndent): Extension {
  return [
    EditorState.tabSize.of(indent.size),
    indentUnit.of(indent.kind === 'tabs' ? '\t' : ' '.repeat(indent.size)),
  ];
}

/**
 * Full IDE editing extension bundle for CodeMirror 6:
 * multi-cursor, rectangular selection, bracket matching & auto-closing, language comment toggling,
 * line move/copy/delete, undo/redo history, save & save-all shortcuts.
 */
export function ideEditingExtensions(options: {
  path: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onSaveAll: () => void;
  onEscape?: () => void;
}): Extension {
  return [
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    dropCursor(),
    highlightSpecialChars(),
    highlightActiveLineGutter(),
    bracketMatching(),
    languageCommentData(options.path),
    autoCloseAndIndentExtension(),
    history(),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { options.onSave(); return true; } },
      { key: 'Mod-Shift-s', preventDefault: true, run: () => { options.onSaveAll(); return true; } },
      { key: 'Mod-/', preventDefault: true, run: toggleComment },
      { key: 'Mod-d', preventDefault: true, run: selectNextOccurrence },
      { key: 'Alt-ArrowUp', preventDefault: true, run: moveLineUp },
      { key: 'Alt-ArrowDown', preventDefault: true, run: moveLineDown },
      { key: 'Shift-Alt-ArrowUp', preventDefault: true, run: copyLineUp },
      { key: 'Shift-Alt-ArrowDown', preventDefault: true, run: copyLineDown },
      { key: 'Mod-Shift-k', preventDefault: true, run: deleteLine },
      {
        key: 'Escape',
        run: (view) => {
          if (searchPanelOpen(view.state)) return false;
          // Collapse multi-cursor back to the primary cursor before leaving editing.
          if (view.state.selection.ranges.length > 1) {
            view.dispatch({ selection: EditorSelection.single(view.state.selection.main.anchor, view.state.selection.main.head) });
            return true;
          }
          if (!options.onEscape) return false;
          options.onEscape();
          return true;
        },
      },
      indentWithTab,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
    }),
  ];
}
